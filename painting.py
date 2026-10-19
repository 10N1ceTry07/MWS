"""Painting queue; area-based jobs, no time/rate calculation."""
import json, uuid, base64
from decimal import Decimal, InvalidOperation
from datetime import datetime

def init(c):
    c.executescript('''CREATE TABLE IF NOT EXISTS painting_orders(id TEXT PRIMARY KEY,source_key TEXT UNIQUE,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS painting_files(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,name TEXT NOT NULL,content BLOB NOT NULL);''')

def fields(b):
    customer=str(b.get('customer','')).strip()
    if not customer or len(customer)>200:raise ValueError('Вкажіть замовника (до 200 символів).')
    due=b.get('due') or ''
    if due:
        try:datetime.strptime(due,'%Y-%m-%d')
        except (ValueError,TypeError):raise ValueError('Некоректна дата готовності.')
    priority=b.get('priority','normal')
    if priority not in ('normal','high','urgent'):raise ValueError('Оберіть пріоритет.')
    area=b.get('area','')
    if area not in ('',None):
        try:
            n=Decimal(str(area).replace(',','.'))
            if not n.is_finite() or n<0 or n.as_tuple().exponent < -3:raise ValueError()
            area=str(n)
        except (ValueError,InvalidOperation):raise ValueError('Площа: невід’ємне число, до трьох знаків після коми.')
    else:area=''
    return dict(customer=customer,priority=priority,due=due,area=area,ral=str(b.get('ral','')).strip()[:100],coating=str(b.get('coating','')).strip()[:200],comment=str(b.get('comment',''))[:4000])

def save(c,o,key=None):
    c.execute('INSERT INTO painting_orders VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',(o['id'],key,json.dumps(o,ensure_ascii=False)))

def transfer(c,parts,department,timestamp):
    if parts and parts[0].get('crmOrderId'):return

    if not parts or not all(o['status']=='done' for o in parts) or not any(o.get('sendToPainting') for o in parts):return
    first=parts[0]
    key=department+':'+(json.dumps([first.get('groupId') or 'legacy',first['number']],ensure_ascii=False) if department=='bending' else first['id'])
    if c.execute('SELECT id FROM painting_orders WHERE source_key=?',(key,)).fetchone():return
    o=dict(id=uuid.uuid4().hex,customer=first.get('customer',first.get('number')),manager=first['manager'],created=timestamp,due=first.get('due',''),priority=first.get('priority','normal'),area='',ral='',coating='',comment=first.get('comment',''),status='queued',reason='',version=1,files=[],history=[],source='Після гнуття' if department=='bending' else 'Після зварювання')
    table='files' if department=='bending' else 'welding_files';seen=set()
    for part in parts:
        for f in part.get('files',[]):
            if f['id'] in seen:continue
            seen.add(f['id']);row=c.execute('SELECT content FROM '+table+' WHERE id=?',(f['id'],)).fetchone()
            if row:
                fid=uuid.uuid4().hex;c.execute('INSERT INTO painting_files VALUES (?,?,?,?)',(fid,o['id'],f['name'],row['content']));o['files'].append(dict(id=fid,name=f['name']))
    o['history'].append(dict(at=timestamp,actor='Система',action=o['source']));save(c,o,key)

def handle(c,path,b,actor,role,now,prepare_files,reasons):
    if role not in ('manager','painting_chief','admin'):return 403,{'error':'Фарбування доступне менеджерам і керівнику фарбування.'}
    action=path.rsplit('/',1)[-1]
    if action=='list':return 200,{'orders':[json.loads(r['payload']) for r in c.execute('SELECT payload FROM painting_orders')]}
    if action in ('file','preview'):
        row=c.execute('SELECT name,content FROM painting_files WHERE id=?',(b.get('id'),)).fetchone()
        if not row:return 404,{'error':'Креслення не знайдено.'}
        if action=='file':return 200,{'name':row['name'],'data':base64.b64encode(row['content']).decode()}
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
        row=c.execute('SELECT payload FROM painting_orders WHERE id=?',(key,)).fetchone()
        if row:
            existing=json.loads(row['payload']);return (200,existing) if existing['manager']==actor else (403,{'error':'Чуже замовлення.'})
        o={**fields(b),'id':key,'manager':actor,'created':now(),'status':'queued','reason':'','version':1,'files':[],'history':[]}
    else:
        row=c.execute('SELECT payload FROM painting_orders WHERE id=?',(b.get('id'),)).fetchone()
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
            o['files']=[f for f in o['files'] if f['id']!=fid];c.execute('DELETE FROM painting_files WHERE id=? AND order_id=?',(fid,o['id']))
        elif action=='delete':
            c.execute('CREATE TABLE IF NOT EXISTS deleted_orders (department TEXT,id TEXT,payload TEXT,actor TEXT,deleted_at TEXT)')
            c.execute('INSERT INTO deleted_orders VALUES (?,?,?,?,?)',('painting',o['id'],json.dumps(o,ensure_ascii=False),actor,now()));c.execute('DELETE FROM painting_orders WHERE id=?',(o['id'],));return 200,{'deleted':o['id']}
        else:return 404,{'error':'Невідома дія.'}
        o['version']+=1
    for fid,name,content in prepare_files(b.get('files',[])):
        c.execute('INSERT INTO painting_files VALUES (?,?,?,?)',(fid,o['id'],name,content));o['files'].append(dict(id=fid,name=name))
    o['history'].append(dict(at=now(),actor=actor,action=action));save(c,o);return 200,o
