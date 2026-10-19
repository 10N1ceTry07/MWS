import time_adjust
import crm
import notes
import base64
import json
import mimetypes
import os
import sys
from pathlib import Path
import sqlite3
import threading
import traceback
import uuid
import re
import io
import secrets
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import welding
import painting
import laser
from pdf_extract import extract, iter_split_pages, filename_fallback
DATA = Path(os.environ.get('BENDING_DATA', str(ROOT / 'data')))
DATA.mkdir(parents=True, exist_ok=True)
STAGING=DATA/'staging'
STAGING.mkdir(exist_ok=True)
DB = DATA / 'queue.sqlite3'
LOCK = threading.Lock()
MANAGERS = ['Артем Кузнеченко','Богдан Зазуляк','Денис Стадник','Тарас Рибачук']
OPERATORS = ['Юра Курочкін','Андрій Сніданко']
SESSIONS = {}
REASONS = ['Обід', 'Кінець зміни', 'Брак', 'Відсутній матеріал / заготовка', 'Інше', 'На порізці', 'Некоректна деталь', 'Некоректні креслення', 'Несправність обладнання']

def now():
    return datetime.now(timezone.utc).isoformat()

def track_work(order, target, timestamp):
    """Persist active intervals; paused/queued time never counts."""
    started = order.get('workStartedAt')
    if started and target != 'working':
        seconds = max(0, (datetime.fromisoformat(timestamp) - datetime.fromisoformat(started)).total_seconds())
        order['workSeconds'] = order.get('workSeconds', 0) + seconds
        order['workStartedAt'] = None
    elif target == 'working' and not started:
        order['workStartedAt'] = timestamp
        order.setdefault('workSeconds', 0)

def connect():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn

def init():
    with connect() as c:
        welding.init(c)
        painting.init(c)
        laser.init(c)
        crm.init(c)
        c.executescript('''CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, name TEXT NOT NULL, content BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, content BLOB NOT NULL);''')

def required(value, label, limit=200):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValueError(f'{label}: заповніть поле (до {limit} символів).')
    return value.strip()

def fields(body):
    result = {k: required(body.get(k), label, limit) for k, label, limit in [('number','Замовник',80), ('title','Назва деталі',200), ('material','Матеріал',100)]}
    try:
        result['thickness'] = float(body.get('thickness', 0))
        quantity = float(body.get('quantity', 0))
        if not 0 < result['thickness'] <= 500 or not 0 < quantity <= 10000000 or not quantity.is_integer():
            raise ValueError()
        result['quantity'] = int(quantity)
    except (TypeError, ValueError):
        raise ValueError('Перевірте товщину (0–500 мм) та цілу кількість (1–10 000 000).')
    result['priority'] = body.get('priority')
    if result['priority'] not in ['urgent','high','normal']:
        raise ValueError('Оберіть пріоритет.')
    cost=body.get('bendingCost')
    if cost not in (None,''):
        from decimal import Decimal, InvalidOperation
        try:
            cost=Decimal(str(cost).replace(',','.'))
            if not cost.is_finite() or cost<0 or cost.as_tuple().exponent < -2:raise ValueError()
        except (InvalidOperation,ValueError):raise ValueError('Вартість: введіть невід’ємну суму до двох знаків після коми.')
        result['bendingCost']=str(cost)
    result['sendToPainting']=body.get('sendToPainting') in (True,'on')
    result['sendToWelding']=body.get('sendToWelding') in (True,'on')
    result['due'] = body.get('due') or ''
    if result['due']:
        try:
            datetime.strptime(result['due'], '%Y-%m-%d')
        except (ValueError, TypeError):
            raise ValueError('Некоректна дата готовності.')
    result['comment'] = str(body.get('comment', '')).strip()[:4000]
    return result

def prepare_files(items):
    if not isinstance(items, list):
        raise ValueError('Потрібен список PDF.')
    result = []
    for item in items:
        name = required(item.get('name'), 'Назва файлу', 200)
        try:
            token=item.get('token')
            if token:
                if not re.fullmatch(r'[0-9a-f]{32}',token):raise ValueError('Некоректний файл.')
                content=(STAGING/token).read_bytes()
            else:
                content = base64.b64decode(item.get('data', ''), validate=True)
        except Exception:
            raise ValueError('Не вдалося прочитати PDF.')
        if not name.lower().endswith('.pdf') or not content.startswith(b'%PDF-'):
            raise ValueError('Можна додавати лише PDF-файли.')
        result.append((uuid.uuid4().hex, name, content))
    return result

class Handler(BaseHTTPRequestHandler):
    def send(self, status, content, mime='application/json; charset=utf-8'):
        if not isinstance(content, bytes):
            content = json.dumps(content, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/orders':
            with connect() as c:
                orders = [json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
            return self.send(200, orders)
        if path.startswith('/photos/'):
            with connect() as c:
                row=c.execute('SELECT content FROM photos WHERE id=?',(path.split('/')[-1],)).fetchone()
            return self.send(200,row['content'],'image/jpeg') if row else self.send(404,{'error':'Фото не знайдено.'})
        if path.startswith('/files/'):
            with connect() as c:
                row = c.execute('SELECT name,content FROM files WHERE id=?', (path.split('/')[-1],)).fetchone()
            return self.send(200, row['content'], 'application/dxf' if row['name'].lower().endswith('.dxf') else 'application/pdf') if row else self.send(404, {'error':'Файл не знайдено.'})
        if path.startswith('/preview/') or path.startswith('/staged-preview/'):
            fid=path.split('/')[-1]
            if not re.fullmatch(r'[0-9a-f]{32}',fid):return self.send(404,{'error':'Файл не знайдено.'})
            if path.startswith('/staged-preview/'):
                try:row={'content':(STAGING/fid).read_bytes()}
                except FileNotFoundError:row=None
            else:
                with connect() as c:
                    row=c.execute('SELECT content FROM files WHERE id=?',(fid,)).fetchone()
            if not row:return self.send(404,{'error':'Файл не знайдено.'})
            try:
                import pypdfium2 as pdfium
                with LOCK:
                    pdf=pdfium.PdfDocument(row['content'])
                    try:
                        page=pdf[0]
                        try:
                            scale=min(1400/page.get_width(),1000/page.get_height())
                            bitmap=page.render(scale=scale)
                            try:
                                out=io.BytesIO();bitmap.to_pil().save(out,format='PNG');content=out.getvalue()
                            finally:bitmap.close()
                        finally:page.close()
                    finally:pdf.close()
                return self.send(200,content,'image/png')
            except Exception:
                return self.send(422,{'error':'Передперегляд недоступний. Відкрийте PDF.'})
        assets = {'/':'index.html','/app.js':'app.js','/import.js':'import.js','/style.css':'style.css','/welding.js':'welding.js','/welding-workers.js':'welding-workers.js','/painting.js':'painting.js','/notes.js':'notes.js','/time-adjust.js':'time-adjust.js','/laser.js':'laser.js','/crm.js':'crm.js'}
        if path in assets:
            file = ROOT / assets[path]
            return self.send(200, file.read_bytes(), (mimetypes.guess_type(str(file))[0] or 'text/plain') + '; charset=utf-8')
        self.send(404, {'error':'Не знайдено.'})

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            if origin and origin != 'http://' + self.headers.get('Host', ''):
                return self.send(403, {'error':'Недозволене джерело запиту.'})
            if not self.headers.get('Content-Type','').startswith('application/json'):
                return self.send(415, {'error':'Потрібен JSON.'})
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0:
                return self.send(400, {'error':'Порожній запит.'})
            body = json.loads(self.rfile.read(length))
            actor = required(body.get('actor'), 'Ім’я працівника', 80)
            role = body.get('role')
            if role not in ['manager','operator','chief','painting_chief','laser_chief','admin']:
                raise ValueError('Оберіть роль працівника.')
            path = urlparse(self.path).path
            if path=='/api/login':
                if not (((role=='manager' and actor in MANAGERS) or (role=='chief' and actor=='Андрій Матуда') or (role=='painting_chief' and actor=='Роман Мустаєв') or (role=='laser_chief' and actor=='Михайлишин Володимир')) and body.get('password')=='0000' or role=='admin' and actor=='ADMIN' and body.get('password')=='1111'):
                    return self.send(403,{'error':'Неправильний пароль або менеджер.'})
                token=secrets.token_hex(32)
                SESSIONS[token]=(actor,time.time()+43200,role)
                return self.send(200,{'token':token})
            if role in ('manager','chief','painting_chief','laser_chief','admin'):
                session=SESSIONS.get(body.get('token',''))
                if not session or session[0]!=actor or session[1]<time.time() or session[2]!=role:
                    return self.send(401,{'error':'Увійдіть у профіль менеджера з паролем повторно.'})
            if path.startswith('/api/crm/'):
                if role not in ('manager','admin'):return self.send(403,{'error':'Простір доступний менеджерам і ADMIN.'})
                with LOCK,connect() as c:
                    crm.sync(c,now())
                    code,data=crm.handle(c,path,body,actor,role,now,MANAGERS)
                return self.send(code,data)
            if path.startswith('/api/laser/'):
                with LOCK,connect() as c:
                    code,data=laser.handle(c,path,body,actor,role,now,prepare_files,REASONS)
                    if code==200:crm.sync(c,now())
                return self.send(code,data)
            if role=='laser_chief' and not path.startswith('/api/notes/'):
                return self.send(403,{'error':'Керівник лазерної порізки має доступ лише до своєї дільниці.'})
            if path=='/api/time-adjust':
                with LOCK,connect() as c:
                    code,data=time_adjust.handle(c,body,actor,role,now())
                return self.send(code,data)
            if path.startswith('/api/notes/'):
                with LOCK,connect() as c:
                    code,data=notes.handle(c,path,body,actor,role,now)
                return self.send(code,data)
            if path.startswith('/api/painting/'):
                with LOCK,connect() as c:
                    code,data=painting.handle(c,path,body,actor,role,now,prepare_files,REASONS)
                    if code==200:crm.sync(c,now())
                return self.send(code,data)
            if role=='painting_chief':return self.send(403,{'error':'Керівник фарбування має доступ до фарбування.'})
            if path.startswith('/api/welding/'):
                with LOCK,connect() as c:
                    code,data=welding.handle(c,path,body,actor,role,now,prepare_files,REASONS)
                    if code==200:crm.sync(c,now())
                return self.send(code,data)
            if role=='chief':return self.send(403,{'error':'Керівник керує замовленнями у розділі Зварювання.'})
            if role=='operator':
                actor='Оператор'
                if body.get('status')=='done':
                    if body.get('completedBy') not in OPERATORS:
                        raise ValueError('Оберіть оператора, який завершує роботу.')
                    actor=body['completedBy']
            if path=='/api/order-delete':
                if role not in ('manager','admin'):return self.send(403,{'error':'Видаляти замовлення може менеджер або ADMIN.'})
                with LOCK,connect() as c:
                    all_orders=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                    first=next((o for o in all_orders if o['id']==body.get('id')),None)
                    if not first:return self.send(404,{'error':'Замовлення не знайдено.'})
                    members=[o for o in all_orders if (o.get('groupId'),o['number'])==(first.get('groupId'),first['number'])]
                    if role!='admin' and any(o['manager']!=actor for o in members):return self.send(403,{'error':'Можна видаляти лише власні замовлення.'})
                    if any(body.get('versions',{}).get(o['id'])!=o['version'] for o in members):return self.send(409,{'error':'Замовлення змінилося. Оновіть список і повторіть.'})
                    c.execute('CREATE TABLE IF NOT EXISTS deleted_orders (department TEXT, id TEXT, payload TEXT, actor TEXT, deleted_at TEXT)')
                    for o in members:
                        c.execute('INSERT INTO deleted_orders VALUES (?,?,?,?,?)',('bending',o['id'],json.dumps(o,ensure_ascii=False),actor,now()))
                        c.execute('DELETE FROM orders WHERE id=?',(o['id'],))
                return self.send(200,{'deleted':[o['id'] for o in members]})
            if path=='/api/order-painting':
                if role not in ('manager','admin'):return self.send(403,{'error':'Передачу на фарбування налаштовує менеджер.'})
                with LOCK,connect() as c:
                    all_orders=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                    first=next((o for o in all_orders if o['id']==body.get('id')),None)
                    if not first:raise ValueError('Замовлення не знайдено.')
                    members=[o for o in all_orders if (o.get('groupId'),o['number'])==(first.get('groupId'),first['number'])]
                    if role!='admin' and any(o['manager']!=actor for o in members):return self.send(403,{'error':'Лише власні замовлення.'})
                    if any(body.get('versions',{}).get(o['id'])!=o['version'] for o in members):return self.send(409,{'error':'Замовлення змінилося. Повторіть дію.'})
                    for o in members:
                        o.update(sendToPainting=body.get('sendToPainting') is True,version=o['version']+1)
                        c.execute('UPDATE orders SET payload=? WHERE id=?',(json.dumps(o,ensure_ascii=False),o['id']))
                    painting.transfer(c,members,'bending',now())
                    crm.sync(c,now())
                return self.send(200,{'orders':members})
            if path=='/api/order-welding':
                if role not in ('manager','admin'):return self.send(403,{'error':'Передачу на зварювання налаштовує менеджер.'})
                with LOCK,connect() as c:
                    all_orders=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                    first=next((o for o in all_orders if o['id']==body.get('id')),None)
                    if not first:raise ValueError('Замовлення не знайдено.')
                    members=[o for o in all_orders if (o.get('groupId'),o['number'])==(first.get('groupId'),first['number'])]
                    if role!='admin' and any(o['manager']!=actor for o in members):return self.send(403,{'error':'Лише власні замовлення.'})
                    if any(body.get('versions',{}).get(o['id'])!=o['version'] for o in members):return self.send(409,{'error':'Замовлення змінилося. Повторіть дію.'})
                    for o in members:
                        o.update(sendToWelding=body.get('sendToWelding') is True,version=o['version']+1)
                        c.execute('UPDATE orders SET payload=? WHERE id=?',(json.dumps(o,ensure_ascii=False),o['id']))
                    welding.transfer(c,members,now())
                    painting.transfer(c,members,'bending',now())
                    crm.sync(c,now())
                return self.send(200,{'orders':members})
            if path=='/api/order-position':
                if role not in ('manager','admin'):return self.send(403,{'error':'Черговість змінює лише менеджер.'})
                due=body.get('position')
                if due not in (None,''):
                    if isinstance(due,bool) or not str(due).isdigit() or int(due)<1:raise ValueError('Номер черги має бути цілим числом від 1.')
                    due=int(due)
                else:due=None
                with LOCK,connect() as c:
                    all_orders=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                    first=next((o for o in all_orders if o['id']==body.get('id')),None)
                    if not first:raise ValueError('Замовлення не знайдено.')
                    members=[o for o in all_orders if (o.get('groupId'),o['number'])==(first.get('groupId'),first['number'])]
                    if any(body.get('versions',{}).get(o['id'])!=o['version'] for o in members):return self.send(409,{'error':'Замовлення змінилося. Повторіть збереження.'})
                    for o in members:
                        o.update(queuePosition=due,version=o['version']+1)
                        o['history'].append({'at':now(),'actor':actor,'action':'Черговість замовлення: '+(str(due) if due else 'не вказана')})
                        c.execute('UPDATE orders SET payload=? WHERE id=?',(json.dumps(o,ensure_ascii=False),o['id']))
                return self.send(200,{'orders':members})
            if path=='/api/order-cost':
                if role not in ('manager','admin'):return self.send(403,{'error':'Вартість змінює лише менеджер.'})
                due=body.get('bendingCost')
                if due not in (None,''):
                    from decimal import Decimal, InvalidOperation
                    try:
                        value=Decimal(str(due).replace(',','.'))
                        if not value.is_finite() or value<0 or value.as_tuple().exponent < -2:raise ValueError()
                        due=str(value)
                    except (InvalidOperation,ValueError):raise ValueError('Введіть невід’ємну суму до двох знаків після коми.')
                else:due=''
                with LOCK,connect() as c:
                    all_orders=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                    first=next((o for o in all_orders if o['id']==body.get('id')),None)
                    if not first:raise ValueError('Замовлення не знайдено.')
                    members=[o for o in all_orders if (o.get('groupId'),o['number'])==(first.get('groupId'),first['number'])]
                    if role=='manager' and any(o.get('manager')!=actor for o in members):
                        return self.send(403,{'error':'Ви можете змінювати лише власні замовлення.'})
                    if any(body.get('versions',{}).get(o['id'])!=o['version'] for o in members):return self.send(409,{'error':'Замовлення змінилося. Повторіть збереження.'})
                    for o in members:
                        o.update(bendingCost=due,version=o['version']+1)
                        o['history'].append({'at':now(),'actor':actor,'action':'Вартість гнуття замовлення: '+(due or 'не вказана')})
                        c.execute('UPDATE orders SET payload=? WHERE id=?',(json.dumps(o,ensure_ascii=False),o['id']))
                return self.send(200,{'orders':members})
            if path=='/api/order-deadline':
                if role not in ('manager','admin'):return self.send(403,{'error':'Дедлайн змінює лише менеджер.'})
                due=body.get('due') or ''
                if due:
                    try:datetime.strptime(due,'%Y-%m-%d')
                    except (TypeError,ValueError):raise ValueError('Некоректна дата готовності.')
                with LOCK,connect() as c:
                    all_orders=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                    first=next((o for o in all_orders if o['id']==body.get('id')),None)
                    if not first:raise ValueError('Замовлення не знайдено.')
                    members=[o for o in all_orders if (o.get('groupId'),o['number'])==(first.get('groupId'),first['number'])]
                    if role=='manager' and any(o.get('manager')!=actor for o in members):
                        return self.send(403,{'error':'Ви можете змінювати лише власні замовлення.'})
                    if any(body.get('versions',{}).get(o['id'])!=o['version'] for o in members):return self.send(409,{'error':'Замовлення змінилося. Повторіть збереження.'})
                    for o in members:
                        o.update(due=due,version=o['version']+1)
                        o['history'].append({'at':now(),'actor':actor,'action':'Бажана готовність замовлення: '+(due or 'не вказана')})
                        c.execute('UPDATE orders SET payload=? WHERE id=?',(json.dumps(o,ensure_ascii=False),o['id']))
                return self.send(200,{'orders':members})
            if path=='/api/order-priority':
                if role not in ('manager','admin'):
                    return self.send(403, {'error':'Змінювати пріоритет може тільки менеджер.'})
                priority=body.get('priority')
                if priority not in ['urgent','high','normal']:raise ValueError('Оберіть пріоритет.')
                with LOCK,connect() as c:
                    all_orders=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                    first=next((o for o in all_orders if o['id']==body.get('id')),None)
                    if not first:raise ValueError('Замовлення не знайдено.')
                    members=[o for o in all_orders if (o.get('groupId'),o['number'])==(first.get('groupId'),first['number'])]
                    if role=='manager' and any(o.get('manager')!=actor for o in members):
                        return self.send(403,{'error':'Ви можете змінювати лише власні замовлення.'})
                    if any(body.get('versions',{}).get(o['id'])!=o['version'] for o in members):
                        return self.send(409,{'error':'Замовлення змінилося. Оновіть сторінку та повторіть дію.'})
                    for o in members:
                        o.update(priority=priority,version=o['version']+1)
                        o['history'].append({'at':now(),'actor':actor,'action':'Пріоритет усього замовлення: '+{'urgent':'Терміновий','high':'Підвищений','normal':'Звичайний'}[priority]})
                        c.execute('UPDATE orders SET payload=? WHERE id=?',(json.dumps(o,ensure_ascii=False),o['id']))
                return self.send(200,{'orders':members})
            if path=='/api/order-status':
                target=body.get('status')
                if target not in ['internal','queued','working','paused','done']:raise ValueError('Оберіть статус.')
                reason=body.get('reason','') if target=='paused' else ''
                comment=str(body.get('stopComment','')).strip() if target=='paused' else ''
                if target=='paused' and (reason not in REASONS or (reason=='Інше' and not comment)):raise ValueError('Вкажіть причину зупинки та пояснення для «Інше».')
                with LOCK,connect() as c:
                    all_orders=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                    first=next((o for o in all_orders if o['id']==body.get('id')),None)
                    if not first:raise ValueError('Замовлення не знайдено.')
                    members=[o for o in all_orders if (o.get('groupId'),o['number'])==(first.get('groupId'),first['number'])]
                    if role=='manager' and any(o.get('manager')!=actor for o in members):
                        return self.send(403,{'error':'Ви можете змінювати лише власні замовлення.'})
                    if any(body.get('versions',{}).get(o['id'])!=o['version'] for o in members):
                        return self.send(409,{'error':'Замовлення змінилося. Оновіть сторінку та повторіть дію.'})
                    labels={'internal':'Внутрішнє','queued':'У черзі','working':'У роботі','paused':'Призупинено','done':'Виконано'}
                    timestamp=now()
                    photos=[]
                    if target=='paused':
                        from PIL import Image, ImageOps
                        for item in body.get('photos',[]):
                            try:
                                raw=base64.b64decode(item['data'],validate=True)
                                with Image.open(io.BytesIO(raw)) as source:
                                    picture=ImageOps.exif_transpose(source).convert('RGB')
                                    picture.thumbnail((2400,2400))
                                    output=io.BytesIO();picture.save(output,format='JPEG',quality=85)
                                photo_id=uuid.uuid4().hex
                                c.execute('INSERT INTO photos VALUES (?,?)',(photo_id,output.getvalue()))
                                photos.append({'id':photo_id,'name':str(item.get('name','Фото'))[:200],'at':timestamp,'actor':actor,'reason':reason,'comment':comment})
                            except Exception as error:
                                raise ValueError('Не вдалося прочитати фото. Використайте JPG, PNG або WebP.') from error
                    for o in members:
                        if photos:o.setdefault('stopPhotos',[]).extend(photos)
                        track_work(o,target,timestamp)
                        o.update(status=target,reason=reason,stopComment=comment,version=o['version']+1)
                        if target=='done':
                            o['completed']=now()
                            o['completedBy']=actor
                        else:
                            o.pop('completed',None)
                            o.pop('completedBy',None)
                        if target=='working':o['operator']=actor
                        o['history'].append({'at':now(),'actor':actor,'action':'Статус усього замовлення: '+labels[target]+('. '+reason+' '+comment if reason else '')})
                        c.execute('UPDATE orders SET payload=? WHERE id=?',(json.dumps(o,ensure_ascii=False),o['id']))
                    welding.transfer(c,members,timestamp)
                    painting.transfer(c,members,'bending',timestamp)
                    crm.sync(c,now())
                return self.send(200,{'orders':members})
            if path=='/api/discard-staged':
                for token in body.get('tokens',[]):
                    if isinstance(token,str) and re.fullmatch(r'[0-9a-f]{32}',token):(STAGING/token).unlink(missing_ok=True)
                return self.send(200,{'ok':True})
            if path == '/api/extract-pdf':
                if role not in ('manager','admin'):
                    return self.send(403, {'error':'Креслення додає менеджер.'})
                files = prepare_files(body.get('files', []))
                results=[]
                total_bytes=0
                for index,(_,name,content) in enumerate(files):
                    parts=iter_split_pages(content,name) if body.get('splitPages') else [(name,content,None,1)]
                    for part_name,part_content,page,count in parts:
                        total_bytes+=len(part_content)
                        result={'name':part_name,**filename_fallback(extract(part_content),name),'inputIndex':index,'page':page,'pageCount':count}
                        if body.get('stage'):
                            token=uuid.uuid4().hex
                            (STAGING/token).write_bytes(part_content)
                            result['token']=token
                        elif count>1:result['data']=base64.b64encode(part_content).decode('ascii')
                        results.append(result)
                return self.send(200, {'files':results})
            if path == '/api/import':
                if role not in ('manager','admin'):
                    return self.send(403, {'error':'Деталі додає менеджер.'})
                items = body.get('items')
                if not isinstance(items, list) or not items:
                    raise ValueError('Додайте деталі.')
                prepared = []
                for item in items:
                    key=item.get('requestId')
                    if key:
                        if not re.fullmatch(r'[0-9a-f]{32}',key):raise ValueError('Некоректний ключ збереження.')
                        with connect() as c:
                            existing=c.execute('SELECT payload FROM orders WHERE id=?',(key,)).fetchone()
                        if existing:
                            prepared.append((json.loads(existing['payload']),None,None,None))
                            continue
                    order = fields({**body, **item})
                    preparation=body.get('weldingPreparation')
                    if preparation is not None and order.get('sendToWelding'):
                        order['weldingCost']=welding.fields({'customer':order['number'],'cost':preparation.get('cost','')})['cost']
                        order['_weldingFiles']=prepare_files(preparation.get('files',[]))
                    group_id=body.get('groupId')
                    if group_id:
                        if not re.fullmatch(r'[0-9a-f]{32}',group_id):raise ValueError('Некоректний ідентифікатор замовлення.')
                        with connect() as c:
                            existing_groups=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                        if role!='admin' and any(o.get('groupId')==group_id and o.get('manager')!=actor for o in existing_groups):
                            return self.send(403,{'error':'Ви можете додавати деталі лише до власних замовлень.'})
                        order['groupId']=group_id
                    manual=item.get('file',{}).get('manual') is True
                    no_pdf_reason=required(item.get('noPdfReason'),'Причина відсутності PDF',4000) if manual else ''
                    files = [] if manual else prepare_files([item.get('file')])
                    order.update(id=key or uuid.uuid4().hex, manager=actor, created=now(), status='queued', reason='', stopComment='', version=1, files=[], history=[])
                    if manual:
                        order['noPdfReason']=no_pdf_reason
                        order['history']=[{'at':now(),'actor':actor,'action':'Додав без PDF: '+no_pdf_reason}]
                        prepared.append((order,'',None,None))
                        continue
                    fid, name, content = files[0]
                    order['files'] = [{'id':fid,'name':name,'size':len(content),'added':now(),'actor':actor}]
                    order['history'] = [{'at':now(),'actor':actor,'action':'Додав деталь з PDF: '+name}]
                    prepared.append((order, fid, name, content))
                with LOCK, connect() as c:
                    for order, fid, name, content in prepared:
                        if fid is None:continue
                        extras=order.pop('_weldingFiles',[])
                        order['weldingDrawings']=[]
                        for extra_id,extra_name,extra_content in extras:
                            c.execute('INSERT INTO files VALUES (?,?,?,?)',(extra_id,order['id'],extra_name,extra_content))
                            order['weldingDrawings'].append({'id':extra_id,'name':extra_name})

                        if fid:c.execute('INSERT INTO files VALUES (?,?,?,?)',(fid,order['id'],name,content))
                        c.execute('INSERT INTO orders VALUES (?,?)',(order['id'],json.dumps(order,ensure_ascii=False)))
                for item in items:
                    token=item.get('file',{}).get('token','')
                    if re.fullmatch(r'[0-9a-f]{32}',token):(STAGING/token).unlink(missing_ok=True)
                return self.send(200, {'orders':[entry[0] for entry in prepared]})
            with LOCK, connect() as c:
                if path == '/api/orders':
                    if role not in ('manager','admin'):
                        return self.send(403, {'error':'Замовлення додає менеджер.'})
                    order = fields(body)
                    order.update(id=uuid.uuid4().hex, manager=actor, created=now(), status='queued', reason='', stopComment='', version=1, files=[], history=[])
                    action = 'Додав замовлення до черги'
                elif path.startswith('/api/orders/'):
                    oid = path.split('/')[-1]
                    row = c.execute('SELECT payload FROM orders WHERE id=?', (oid,)).fetchone()
                    if not row:
                        return self.send(404, {'error':'Замовлення не знайдено.'})
                    order = json.loads(row['payload'])
                    if role=='manager' and order.get('manager')!=actor:
                        return self.send(403,{'error':'Ви можете змінювати лише власні замовлення.'})
                    if body.get('version') != order['version']:
                        return self.send(409, {'error':'Замовлення вже змінилося. Оновіть його й повторіть дію.'})
                    mode = body.get('action')
                    if mode == 'edit':
                        if role!='admin' and (role!='manager' or order['status'] not in ['internal','queued','paused']):
                            return self.send(403, {'error':'Редагування можливе менеджером у черзі або після призупинення.'})
                        new = fields(body)
                        if 'sendToWelding' not in body:new.pop('sendToWelding',None)
                        if 'sendToPainting' not in body:new.pop('sendToPainting',None)
                        changed = [k for k in new if new[k] != order.get(k)]
                        labels = {'number':'номер','title':'назва','material':'матеріал','thickness':'товщина','quantity':'кількість','priority':'пріоритет','due':'дата готовності','comment':'коментар'}
                        changes = [f'{labels.get(k,k)}: {order.get(k) or "—"} → {new[k] or "—"}' for k in changed]
                        order.update(new)
                        action = 'Оновив замовлення' + (': ' + '; '.join(changes) if changes else '')
                    elif mode == 'status':
                        if role not in ('operator','admin'):
                            return self.send(403, {'error':'Стан роботи змінює оператор.'})
                        target = body.get('status')
                        allowed = {'internal':['queued','working','paused','done'], 'queued':['internal','working','paused'], 'working':['internal','paused','done'], 'paused':['internal','queued'], 'done':[]}
                        if target not in allowed[order['status']]:
                            raise ValueError('Такий перехід статусу недоступний.')
                        if target == 'paused':
                            reason = body.get('reason')
                            if reason not in REASONS:
                                raise ValueError('Оберіть причину зупинки.')
                            comment = str(body.get('stopComment', '')).strip()[:4000]
                            if reason == 'Інше' and not comment:
                                raise ValueError('Опишіть причину зупинки.')
                            order.update(reason=reason, stopComment=comment)
                            action = 'Призупинив: ' + reason + ('. ' + comment if comment else '')
                        else:
                            action = {'working':'Взяв у роботу','done':'Завершив замовлення','queued':'Підтвердив усунення проблеми та повернув у чергу'}[target]
                            order.update(reason='', stopComment='')
                        track_work(order,target,now())
                        order['status'] = target
                        if target == 'working':
                            order['operator'] = actor
                        if target == 'done':
                            order['completed'] = now()
                            order['completedBy'] = actor
                    else:
                        raise ValueError('Невідома дія.')
                    order['version'] += 1
                else:
                    return self.send(404, {'error':'Не знайдено.'})
                files = prepare_files(body.get('files', []))
                if len(files) > 1 or (path == '/api/orders' and len(files) != 1):
                    raise ValueError('Одна деталь повинна мати один PDF. Для кількох файлів скористайтеся імпортом деталей.')
                if files and (role not in ('manager','admin') or body.get('action') == 'status'):
                    raise ValueError('Креслення додає менеджер під час редагування.')
                for fid, name, content in files:
                    if order['files']:
                        order.setdefault('previousFiles', []).extend(order['files'])
                        order['files'] = []
                    c.execute('INSERT INTO files VALUES (?,?,?,?)', (fid,order['id'],name,content))
                    order['files'].append({'id':fid,'name':name,'size':len(content),'added':now(),'actor':actor})
                if files:
                    action += '. Додав PDF: ' + ', '.join(f[1] for f in files)
                order['history'].append({'at':now(),'actor':actor,'action':action})
                c.execute('INSERT OR REPLACE INTO orders VALUES (?,?)',(order['id'],json.dumps(order,ensure_ascii=False)))
                if order['status']=='done':
                    related=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
                    related=[o for o in related if (o.get('groupId'),o['number'])==(order.get('groupId'),order['number'])]
                    welding.transfer(c,related,now())
                    painting.transfer(c,related,'bending',now())
                    crm.sync(c,now())
            self.send(200, order)
        except (ValueError, TypeError, KeyError, AttributeError) as e:
            self.send(400, {'error':str(e) or 'Некоректний запит.'})
        except Exception:
            traceback.print_exc()
            self.send(500, {'error':'Не вдалося зберегти. Перевірте вільне місце та повторіть дію.'})

if __name__ == '__main__':
    init()
    port = int(os.environ.get('BENDING_PORT', '8765'))
    print(f'Bending queue: http://127.0.0.1:{port}', flush=True)
    host = os.environ.get('BENDING_HOST', '127.0.0.1')
    ThreadingHTTPServer((host,port),Handler).serve_forever()
