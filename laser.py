"""Painting queue; area-based jobs, no time/rate calculation."""
import json, uuid, base64
from decimal import Decimal, InvalidOperation
from datetime import datetime

def init(c):
    c.executescript('''CREATE TABLE IF NOT EXISTS laser_orders(id TEXT PRIMARY KEY,source_key TEXT UNIQUE,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS laser_transfers(laser_id TEXT PRIMARY KEY,bending_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS laser_files(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,name TEXT NOT NULL,content BLOB NOT NULL);''')

def fields(b):
    customer=str(b.get('customer','')).strip()
    if not customer or len(customer)>80:raise ValueError('Вкажіть замовника (до 80 символів).')
    title=str(b.get('title','')).strip()
    material=str(b.get('material','')).strip()
    if not title or len(title)>200:raise ValueError('Вкажіть назву деталі / робіт (до 200 символів).')
    if not material or len(material)>100:raise ValueError('Вкажіть матеріал (до 100 символів).')
    def number(key,maximum,required=False):
        raw=b.get(key,'')
        if raw in ('',None) and not required:return ''
        try:
            n=Decimal(str(raw).replace(',','.'))
            if not n.is_finite() or n<0 or n>maximum or (required and n==0):raise ValueError()
            return n
        except (ValueError,InvalidOperation):raise ValueError('Некоректне поле: '+key)
    thickness=number('thickness',500,True);quantity=number('quantity',10000000,True);cost=number('cost',1000000000)
    if quantity!=quantity.to_integral_value():raise ValueError('Кількість має бути цілим числом.')
    if cost!='' and cost.as_tuple().exponent < -2:raise ValueError('Вартість: до двох знаків після коми.')
    due=b.get('due') or ''
    if due:
        try:datetime.strptime(due,'%Y-%m-%d')
        except (ValueError,TypeError):raise ValueError('Некоректна дата готовності.')
    priority=b.get('priority','normal')
    if priority not in ('normal','high','urgent'):raise ValueError('Оберіть пріоритет.')
    return dict(customer=customer,title=title,material=material,thickness=float(thickness),quantity=int(quantity),cost=str(cost),due=due,priority=priority,comment=str(b.get('comment',''))[:4000],sendToBending=b.get('sendToBending') in (True,'on'))

def prepare_laser_files(items):
    if not isinstance(items,list):raise ValueError('Потрібен список файлів.')
    result=[]
    for item in items:
        if not isinstance(item,dict):raise ValueError('Некоректний файл.')
        name=str(item.get('name','')).strip()
        if not name or len(name)>200 or not name.lower().endswith(('.pdf','.dxf')):raise ValueError('Дозволено PDF та DXF.')
        try:content=base64.b64decode(item.get('data',''),validate=True)
        except Exception:raise ValueError('Не вдалося прочитати файл.')
        if name.lower().endswith('.pdf'):
            if not content.startswith(b'%PDF-'):raise ValueError('Некоректний PDF.')
        elif not (content.startswith(b'AutoCAD Binary DXF') or (b'SECTION' in content.upper() and b'EOF' in content.upper())):raise ValueError('Некоректний DXF.')
        result.append((uuid.uuid4().hex,name,content))
    return result

def save(c,o,key=None):
    c.execute('INSERT INTO laser_orders VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',(o['id'],key,json.dumps(o,ensure_ascii=False)))

def transfer(c,o,timestamp):
    if o.get('crmOrderId'):return

    if o['status']!='done' or not o.get('sendToBending'):return
    if c.execute('SELECT 1 FROM laser_transfers WHERE laser_id=?',(o['id'],)).fetchone():return
    ident=uuid.uuid4().hex
    bending=dict(id=ident,groupId='laser-'+o['id'],number=o['customer'],title=o['title'],material=o['material'],thickness=o['thickness'],quantity=o['quantity'],priority=o['priority'],due=o['due'],comment=o['comment'],manager=o['manager'],created=timestamp,status='queued',version=1,files=[],history=[dict(at=timestamp,actor='Система',action='Передано з лазерної порізки')],sourceLaserId=o['id'],source='Після лазерної порізки')
    for f in o['files']:
        row=c.execute('SELECT content FROM laser_files WHERE id=?',(f['id'],)).fetchone()
        if row:
            fid=uuid.uuid4().hex;c.execute('INSERT INTO files VALUES (?,?,?,?)',(fid,ident,f['name'],row['content']));bending['files'].append(dict(id=fid,name=f['name'],size=len(row['content']),added=timestamp))
    bending['files'].sort(key=lambda f:not f['name'].lower().endswith('.pdf'))
    if not any(f['name'].lower().endswith('.pdf') for f in bending['files']):bending['noPdfReason']='Передано з лазерної порізки без PDF; креслення DXF доступні у файлах.' if bending['files'] else 'Передано з лазерної порізки без креслень.'
    c.execute('INSERT INTO orders VALUES (?,?)',(ident,json.dumps(bending,ensure_ascii=False)))
    c.execute('INSERT INTO laser_transfers VALUES (?,?)',(o['id'],ident))
    o['bendingOrderId']=ident

def handle(c,path,b,actor,role,now,prepare_files,reasons):
    if role not in ('manager','laser_chief','admin'):return 403,{'error':'Лазерна порізка доступне менеджерам і керівнику лазерної порізки.'}
    prepare_files=prepare_laser_files
    action=path.rsplit('/',1)[-1]
    if action=='list':return 200,{'orders':[json.loads(r['payload']) for r in c.execute('SELECT payload FROM laser_orders')]}
    if action in ('file','preview'):
        row=c.execute('SELECT name,content FROM laser_files WHERE id=?',(b.get('id'),)).fetchone()
        if not row:return 404,{'error':'Креслення не знайдено.'}
        if action=='file':return 200,{'name':row['name'],'data':base64.b64encode(row['content']).decode()}
        if not row['name'].lower().endswith('.pdf'):return 422,{'error':'Для DXF доступне завантаження файлу.'}
        import io,pypdfium2 as pdfium
        pdf=pdfium.PdfDocument(row['content'])
        try:
            page=pdf[0]
            try:
                bitmap=page.render(scale=min(1400/page.get_width(),1000/page.get_height()))
                try:out=io.BytesIO();bitmap.to_pil().save(out,format='PNG')
                finally:bitmap.close()
            finally:page.close()
        finally:pdf.close()
        return 200,{'data':base64.b64encode(out.getvalue()).decode()}
    if action=='create':
        key=b.get('requestId','')
        if len(key)!=32 or any(ch not in '0123456789abcdef' for ch in key):raise ValueError('Некоректний ключ запиту.')
        row=c.execute('SELECT payload FROM laser_orders WHERE id=?',(key,)).fetchone()
        if row:
            existing=json.loads(row['payload']);return (200,existing) if existing['manager']==actor else (403,{'error':'Чуже замовлення.'})
        o={**fields(b),'id':key,'manager':actor,'created':now(),'status':'queued','reason':'','version':1,'files':[],'history':[]}
    else:
        row=c.execute('SELECT payload FROM laser_orders WHERE id=?',(b.get('id'),)).fetchone()
        if not row:return 404,{'error':'Замовлення не знайдено.'}
        o=json.loads(row['payload'])
        if role=='manager' and o['manager']!=actor and action!='position':return 403,{'error':'Можна змінювати лише власні замовлення.'}
        if b.get('version')!=o['version']:return 409,{'error':'Замовлення змінилося. Відкрийте його повторно.'}
        if action=='edit':o.update(fields({**o,**b}))
        elif action=='position':
            n=b.get('position')
            if n not in ('',None) and (isinstance(n,bool) or not str(n).isdigit() or int(n)<1):raise ValueError('Вкажіть цілий номер від 1.')
            o['queuePosition']=int(n) if n not in ('',None) else None
        elif action=='status':
            status=b.get('status')
            if status not in ('internal','queued','working','paused','done'):raise ValueError('Некоректний статус.')
            reason=b.get('reason','') if status=='paused' else ''
            if status=='paused' and reason not in reasons:raise ValueError('Оберіть причину зупинки.')
            comment=str(b.get('stopComment','')).strip()[:4000] if status=='paused' else ''
            if reason=='Інше' and not comment:raise ValueError('Опишіть причину зупинки.')
            o.update(status=status,reason=reason,stopComment=comment)
            if status=='done':o.update(completed=now(),completedBy=actor)
            else:o.pop('completed',None);o.pop('completedBy',None)
        elif action=='remove-file':
            fid=b.get('fileId')
            if not any(f['id']==fid for f in o['files']):return 404,{'error':'Креслення не знайдено.'}
            o['files']=[f for f in o['files'] if f['id']!=fid];c.execute('DELETE FROM laser_files WHERE id=? AND order_id=?',(fid,o['id']))
        elif action=='delete':
            c.execute('CREATE TABLE IF NOT EXISTS deleted_orders (department TEXT,id TEXT,payload TEXT,actor TEXT,deleted_at TEXT)')
            c.execute('INSERT INTO deleted_orders VALUES (?,?,?,?,?)',('laser',o['id'],json.dumps(o,ensure_ascii=False),actor,now()));c.execute('DELETE FROM laser_orders WHERE id=?',(o['id'],));return 200,{'deleted':o['id']}
        else:return 404,{'error':'Невідома дія.'}
        o['version']+=1
    for fid,name,content in prepare_files(b.get('files',[])):
        c.execute('INSERT INTO laser_files VALUES (?,?,?,?)',(fid,o['id'],name,content));o['files'].append(dict(id=fid,name=name))
    o['history'].append(dict(at=now(),actor=actor,action=action));transfer(c,o,now());save(c,o);return 200,o
