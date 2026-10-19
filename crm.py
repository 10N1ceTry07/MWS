"""Manager-owned customers and independently tracked production routes."""
import json,uuid,base64
from datetime import datetime
from decimal import Decimal,InvalidOperation
STAGES=('laser','bending','welding','painting')
TABLES={'laser':'laser_orders','bending':'orders','welding':'welding_orders','painting':'painting_orders'}
FILES={'laser':'laser_files','bending':'files','welding':'welding_files','painting':'painting_files'}
def init(c):
    c.executescript("CREATE TABLE IF NOT EXISTS crm_clients(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS crm_orders(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS crm_files(id TEXT PRIMARY KEY,order_id TEXT,name TEXT,content BLOB);")
def save(c,table,o):
    c.execute('INSERT INTO '+table+' VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',(o['id'],json.dumps(o,ensure_ascii=False)))
def get(c,table,ident):
    row=c.execute('SELECT payload FROM '+table+' WHERE id=?',(ident,)).fetchone()
    return json.loads(row['payload']) if row else None

def accessible(c,o,actor,role,client=False):
    if role=='admin':return True
    return client or o.get('manager')==actor


def dispatch(c,o,stage,timestamp,previous=None):
    ident=uuid.uuid4().hex
    item=dict(id=ident,crmOrderId=o['id'],crmRoute=o['route'],clientId=o['clientId'],manager=o['manager'],created=timestamp,status='queued',version=1,priority=o['priority'],due=o['due'],comment=o['comment'],files=[],history=[dict(at=timestamp,actor='Система',action='Маршрут замовлення: '+o['title'])],source='Замовлення менеджера: '+o['title'],reason='')
    cost=o['costs'].get(stage,'')
    if stage=='bending':
        item.update(number=o['customer'],groupId='crm-'+o['id'],title=o['title'],material=o['material'],thickness=o['thickness'],quantity=o['quantity'],bendingCost=cost)
    else:
        item.update(customer=o['customer'],title=o['title'],cost=cost)
        if stage=='laser':item.update(material=o['material'],thickness=o['thickness'],quantity=o['quantity'],sendToBending=False)
        elif stage=='welding':item.update(welder='',assignedWelders=[],sendToPainting=False)
        else:item.update(area=o.get('area',''),ral=o.get('ral',''),coating=o.get('coating',''))
    source_table='crm_files';file_list=o.get('files',[])
    if previous:
        source_table=FILES[previous[0]];file_list=previous[1].get('files',[])
    for f in file_list:
        row=c.execute('SELECT content FROM '+source_table+' WHERE id=?',(f['id'],)).fetchone()
        if row:
            fid=uuid.uuid4().hex;c.execute('INSERT INTO '+FILES[stage]+' VALUES (?,?,?,?)',(fid,ident,f['name'],row['content']))
            item['files'].append(dict(id=fid,name=f['name'],size=len(row['content']),added=timestamp))
    item['files'].sort(key=lambda f:not f['name'].lower().endswith('.pdf'))
    if stage=='bending' and not any(f['name'].lower().endswith('.pdf') for f in item['files']):item['noPdfReason']=o['noPdfReason'] or 'Передано за маршрутом менеджера без PDF.'
    if stage=='bending':c.execute('INSERT INTO orders VALUES (?,?)',(ident,json.dumps(item,ensure_ascii=False)))
    else:c.execute('INSERT INTO '+TABLES[stage]+' VALUES (?,?,?)',(ident,'crm:'+o['id'],json.dumps(item,ensure_ascii=False)))
    o.setdefault('stages',{})[stage]=ident
    o.setdefault('history',[]).append(dict(at=timestamp,action='Передано на дільницю',stage=stage))

def sync(c,timestamp):
    for row in c.execute('SELECT payload FROM crm_orders').fetchall():
        o=json.loads(row['payload'])
        if o.get('state')!='production':continue
        for index,stage in enumerate(o['route']):
            ident=o.get('stages',{}).get(stage)
            if not ident:break
            item=get(c,TABLES[stage],ident)
            if not item or item['status']!='done':break
            if index+1<len(o['route']):
                next_stage=o['route'][index+1]
                if next_stage not in o['stages']:
                    dispatch(c,o,next_stage,timestamp,(stage,item));o['version']+=1;save(c,'crm_orders',o)
            # Completion is derived from stage records, so reopening remains visible.

def present(c,o):
    result=dict(o);progress=[]
    for stage in o['route']:
        ident=o.get('stages',{}).get(stage);item=get(c,TABLES[stage],ident) if ident else None
        progress.append(dict(stage=stage,id=ident,status=item['status'] if item else ('missing' if ident else 'waiting')))
    result['progress']=progress
    result['finished']=bool(progress) and all(p['status']=='done' for p in progress)
    return result

def text(b,k,label,limit,required=False):
    v=str(b.get(k,'')).strip()
    if len(v)>limit or (required and not v):raise ValueError(label+': заповніть коректно.')
    return v

def handle(c,path,b,actor,role,now,managers):
    if role not in ('manager','admin'):return 403,{'error':'Простір доступний менеджерам і ADMIN.'}
    action=path.rsplit('/',1)[-1]
    if action=='list':
        clients=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM crm_clients')]
        clients=[o for o in clients if not o.get('deleted')]
        orders=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM crm_orders')]
        return 200,{'clients':clients,'orders':[present(c,o) for o in orders if accessible(c,o,actor,role)],'managers':managers}
    if action=='file':
        r=c.execute('SELECT name,content,order_id FROM crm_files WHERE id=?',(b.get('id'),)).fetchone()
        if r and not accessible(c,get(c,'crm_orders',r['order_id']) or {},actor,role):return 403,{'error':'Немає доступу до клієнта.'}
        return (200,dict(name=r['name'],data=base64.b64encode(r['content']).decode())) if r else (404,{'error':'Файл не знайдено.'})
    table='crm_clients' if action in ('client-save','client-delete') else 'crm_orders'
    editing=bool(b.get('id'));ident=b.get('id') or b.get('requestId')
    try:
        if not isinstance(ident,str) or len(ident)!=32:int('invalid')
        int(ident,16)
    except (ValueError,TypeError):return 400,{'error':'Некоректний ключ запиту.'}
    existing=get(c,table,ident)
    if existing and not accessible(c,existing,actor,role,table=='crm_clients'):return 403,{'error':'Немає доступу до клієнта.'}
    if editing and not existing:return 404,{'error':'Запис не знайдено.'}
    if not editing and existing:return (200,present(c,existing) if table=='crm_orders' else existing) if existing.get('createdBy')==actor else (409,{'error':'Ключ уже використано.'})
    if existing and b.get('version')!=existing['version']:return 409,{'error':'Запис змінився. Відкрийте його повторно.'}
    if action=='client-delete':
        if not existing:return 404,{'error':'Замовника не знайдено.'}
        existing.update(deleted=True,deletedBy=actor,deletedAt=now(),version=existing['version']+1)
        save(c,'crm_clients',existing)
        return 200,{'ok':True}
    if action=='client-save':
        if existing and existing.get('deleted'):return 409,{'error':'Замовника вже видалено.'}
        responsible=b.get('manager')
        if responsible not in managers:raise ValueError('Оберіть відповідального менеджера.')
        o=dict(existing or {},id=ident,name=text(b,'name','Назва',80,True),contact=text(b,'contact','Контактна особа',200),phone=text(b,'phone','Телефон',100),email=text(b,'email','Email',200),comment=text(b,'comment','Коментар',4000),manager=responsible,version=(existing or {}).get('version',0)+1,updated=now())
    elif action=='order-save':
        if existing and existing['state']!='draft':return 400,{'error':'Після запуску дані змінюються в замовленні відповідної дільниці.'}
        client=get(c,'crm_clients',b.get('clientId'))
        if not client or (client.get('deleted') and (not existing or existing['clientId']!=client['id'])):return 404,{'error':'Оберіть клієнта.'}
        if not accessible(c,client,actor,role,True):return 403,{'error':'Немає доступу до клієнта.'}
        selected=b.get('route')
        if not isinstance(selected,list) or not selected or any(x not in STAGES for x in selected) or len(set(selected))!=len(selected):raise ValueError('Оберіть етапи маршруту.')
        route=[s for s in STAGES if s in selected]
        title=text(b,'title','Назва замовлення / деталі',200,True);material=text(b,'material','Матеріал',100,bool(set(route)&{'laser','bending'}))
        try:
            thickness=float(str(b.get('thickness') or 0).replace(',','.'));quantity=int(b.get('quantity') or 1)
            import math
            if not math.isfinite(thickness) or thickness<0 or not 0<quantity<=10000000:raise ValueError()
            if set(route)&{'laser','bending'} and not (0<thickness<=500 and 0<quantity<=10000000):raise ValueError()
        except (ValueError,TypeError):raise ValueError('Перевірте товщину та кількість.')
        due=b.get('due') or ''
        if due:
            try:datetime.strptime(due,'%Y-%m-%d')
            except (ValueError,TypeError):raise ValueError('Некоректна дата.')
        priority=b.get('priority','normal')
        if priority not in ('normal','high','urgent'):raise ValueError('Некоректний пріоритет.')
        if not isinstance(b.get('costs',{}),dict):raise ValueError('Перевірте вартість етапів.')
        costs={}
        for stage in route:
            raw=b.get('costs',{}).get(stage,'')
            if raw in ('',None):costs[stage]='';continue
            try:
                n=Decimal(str(raw).replace(',','.'))
                if not n.is_finite() or n<0 or n.as_tuple().exponent < -2:raise ValueError()
                costs[stage]=str(n)
            except (ValueError,InvalidOperation):raise ValueError('Перевірте вартість етапів.')
        import laser
        uploads=laser.prepare_laser_files(b.get('files',[]))
        o=dict(existing or {},id=ident,clientId=client['id'],customer=client['name'],manager=(existing or {}).get('manager',actor if role=='manager' else client['manager']),title=title,material=material,thickness=thickness,quantity=quantity,priority=priority,due=due,comment=text(b,'comment','Коментар',4000),noPdfReason=text(b,'noPdfReason','Причина відсутності PDF',4000),route=route,costs=costs,state='draft',version=(existing or {}).get('version',0)+1,files=list((existing or {}).get('files',[])))
        for fid,name,content in uploads:
            c.execute('INSERT INTO crm_files VALUES (?,?,?,?)',(fid,ident,name,content));o['files'].append(dict(id=fid,name=name))
        if 'bending' in route and not any(f['name'].lower().endswith('.pdf') for f in o['files']) and not o['noPdfReason']:raise ValueError('Вкажіть причину передачі на гнуття без PDF.')
    elif action=='launch':
        if not existing:return 404,{'error':'Замовлення не знайдено.'}
        if existing['state']!='draft':return 409,{'error':'Замовлення вже передане у виробництво.'}
        o=existing;o.update(state='production',version=o['version']+1);dispatch(c,o,o['route'][0],now())
    else:return 404,{'error':'Невідома дія.'}
    if not existing:o.update(created=now(),createdBy=actor)
    save(c,table,o)
    return 200,present(c,o) if table=='crm_orders' else o
