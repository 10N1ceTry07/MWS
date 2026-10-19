"""Separate welding orders, sharing the production SQLite database."""
import base64
import painting
import json
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation

WELDERS = ['Андрій Матуда', 'Олег Матуда', 'Василь Дудурич', 'Володимир Пристайко', 'Артем Івахов', 'Віталій Матросов', 'Дмитро Каличак']

def init(c):
    c.executescript('''CREATE TABLE IF NOT EXISTS welding_orders(id TEXT PRIMARY KEY, source_key TEXT UNIQUE, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS welding_files(id TEXT PRIMARY KEY, order_id TEXT NOT NULL, name TEXT NOT NULL, content BLOB NOT NULL);''')

    # Upgrade orders left awaiting supervisor confirmation by earlier versions.
    for row in c.execute('SELECT id,payload FROM welding_orders').fetchall():
        o=json.loads(row['payload'])
        if o.get('status')=='working' and o.get('workerJobs') and all(w.get('status')=='done' for w in o['workerJobs']):
            o.update(status='review',reason='',version=o.get('version',0)+1)
            c.execute('UPDATE welding_orders SET payload=? WHERE id=?',(json.dumps(o,ensure_ascii=False),row['id']))

def priority(value):
    if value not in ('normal','high','urgent'):raise ValueError('Оберіть коректний пріоритет.')
    return value

def fields(body):
    customer=str(body.get('customer','')).strip()
    if not customer or len(customer)>200:raise ValueError('Вкажіть замовника (до 200 символів).')
    due=body.get('due') or ''
    if due:
        try:datetime.strptime(due,'%Y-%m-%d')
        except (TypeError,ValueError):raise ValueError('Некоректний дедлайн.')
    cost=body.get('cost')
    if cost not in (None,''):
        try:
            cost=Decimal(str(cost).replace(',','.'))
            if not cost.is_finite() or cost<0 or cost.as_tuple().exponent < -2:raise ValueError()
        except (InvalidOperation,ValueError):raise ValueError('Вкажіть коректну вартість зварювальних робіт.')
        cost=str(cost)
    else:cost=''
    return dict(sendToPainting=body.get('sendToPainting') in (True,'on'),priority=priority(body.get('priority','normal')),customer=customer,due=due,cost=cost,comment=str(body.get('comment',''))[:4000])

def save(c,o,source=None):
    c.execute('INSERT INTO welding_orders VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (o['id'],source,json.dumps(o,ensure_ascii=False)))

def transfer(c,parts,timestamp):
    if parts and parts[0].get('crmOrderId'):return

    if not parts or not all(o['status']=='done' for o in parts) or not any(o.get('sendToWelding') for o in parts):return
    first=parts[0];key=json.dumps([first.get('groupId') or 'legacy',first['number']],ensure_ascii=False)
    if c.execute('SELECT id FROM welding_orders WHERE source_key=?',(key,)).fetchone():return
    o=dict(priority=min((o.get('priority','normal') for o in parts),key=lambda p:{'urgent':0,'high':1,'normal':2}[p]),id=uuid.uuid4().hex,customer=first['number'],manager=first['manager'],created=timestamp,due=first.get('due',''),cost=next((p['weldingCost'] for p in parts if 'weldingCost' in p),''),comment=first.get('comment',''),status='queued',welder='',reason='',version=1,files=[],source='Після гнуття',history=[])
    seen=set()
    extra_drawings=[f for p in parts for f in p.get('weldingDrawings',[])]
    sources=[{'files':extra_drawings}] if extra_drawings else parts
    for part in sources:
        for f in part.get('files',[]):
            if f['id'] in seen:continue
            seen.add(f['id'])
            row=c.execute('SELECT content FROM files WHERE id=?',(f['id'],)).fetchone()
            if row:
                fid=uuid.uuid4().hex
                c.execute('INSERT INTO welding_files VALUES (?,?,?,?)',(fid,o['id'],f['name'],row['content']))
                o['files'].append(dict(id=fid,name=f['name']))
    o['history'].append(dict(at=timestamp,actor='Система',action='Передано з гнуття'))
    save(c,o,key)

PROCESS_KEYS=('welding','support','logistics','other')

def worker_hours(body):
    values=body.get('processHours')
    if not isinstance(values,dict):raise ValueError('Вкажіть години за процесами.')
    hours={}
    for key in PROCESS_KEYS:
        try:
            value=Decimal(str(values.get(key,'')).strip().replace(',','.') or '0')
            if not value.is_finite() or value<0 or value.as_tuple().exponent < -2:raise ValueError()
        except (InvalidOperation,ValueError):raise ValueError('Години: невід’ємне число, до двох знаків після коми.')
        hours[key]=str(value)
    comment=str(body.get('processHoursComment','')).strip()
    if len(comment)>4000:raise ValueError('Коментар: максимум 4000 символів.')
    if Decimal(hours['other'])>0 and not comment:raise ValueError('Для процесу «Інше» додайте коментар.')
    return hours,comment

def update_worker_totals(o,timestamp):
    totals={k:Decimal(str(o.get('legacyProcessHours',{}).get(k,0))) for k in PROCESS_KEYS}
    comments=[]
    for worker in o.get('workerJobs',[]):
        subtotal={k:Decimal(0) for k in PROCESS_KEYS}
        for segment in worker.get('segments',[]):
            for k in PROCESS_KEYS:subtotal[k]+=Decimal(segment['processHours'].get(k,'0'))
            if segment.get('comment'):comments.append(worker['welder']+': '+segment['comment'])
        worker['processHours']={k:str(v) for k,v in subtotal.items()}
        for k in PROCESS_KEYS:totals[k]+=subtotal[k]
    o['processHours']={k:str(v) for k,v in totals.items()}
    o['processHoursComment']='\n'.join(([o['legacyProcessHoursComment']] if o.get('legacyProcessHoursComment') else [])+comments)
    o['processHoursAt']=timestamp

def worker_action(o,path,body,actor,role,timestamp):
    if role not in ('chief','admin'):return 403,{'error':'Облік роботи зварювальників доступний керівнику дільниці та ADMIN.'}
    jobs=o.get('workerJobs',[])
    if path.endswith('worker-start'):
        name=body.get('welder')
        if name not in WELDERS:raise ValueError('Оберіть зварювальника зі списку.')
        if o['status']=='done':return 409,{'error':'Замовлення вже виконане. Спочатку поверніть його в чергу.'}
        job=next((w for w in jobs if w['welder']==name),None)
        if job and job['status']=='working':return 409,{'error':'Цей зварювальник уже працює над замовленням.'}
        if 'legacyProcessHours' not in o:
            o['legacyProcessHours']=o.get('processHours',{}).copy()
            o['legacyProcessHoursComment']=o.get('processHoursComment','')
        if job is None:
            job=dict(id=uuid.uuid4().hex,welder=name,elapsedSeconds=0,segments=[])
            jobs.append(job)
        job.update(status='working',startedAt=timestamp)
        job.pop('completedAt',None)
        o['workerJobs']=jobs
        assigned=o.get('assignedWelders') or ([o['welder']] if o.get('welder') else [])
        o['assignedWelders']=list(dict.fromkeys(assigned+[name]));o['welder']=', '.join(o['assignedWelders'])
        o.update(status='working',reason='');o.pop('completed',None);o.pop('completedBy',None)
        action='Почав роботу: '+name
    else:
        job=next((w for w in jobs if w['id']==body.get('workerJobId')),None)
        if not job:return 404,{'error':'Запис зварювальника не знайдено.'}
        target=body.get('status')
        if target not in ('paused','done'):raise ValueError('Оберіть призупинення або завершення.')
        if job['status']!='working' and not (job['status']=='paused' and target=='done'):return 409,{'error':'Цей запис уже зупинено. Оновіть замовлення.'}
        hours,comment=worker_hours(body)
        started=job.get('startedAt')
        seconds=max(0,(datetime.fromisoformat(timestamp)-datetime.fromisoformat(started)).total_seconds()) if started else 0
        job.setdefault('segments',[]).append(dict(id=uuid.uuid4().hex,startedAt=started,stoppedAt=timestamp,elapsedSeconds=seconds,processHours=hours,comment=comment,status=target,actor=actor))
        job.update(status=target,startedAt=None,elapsedSeconds=job.get('elapsedSeconds',0)+seconds)
        if target=='done':job['completedAt']=timestamp
        if any(w['status']=='working' for w in jobs):o.update(status='working',reason='')
        elif any(w['status']=='paused' for w in jobs):o.update(status='paused',reason='Роботу зварювальників призупинено')
        else:o.update(status='review',reason='')
        action=('Завершив: ' if target=='done' else 'Призупинив: ')+job['welder']
    update_worker_totals(o,timestamp)
    o['processHoursBy']=actor
    return 200,action

def handle(c,path,body,actor,role,now,prepare_files,reasons):
    if role not in ('manager','chief','admin'):return 403,{'error':'Зварювання доступне менеджерам і керівнику дільниці.'}
    if path=='/api/welding/list':
        return 200,{'orders':[json.loads(r['payload']) for r in c.execute('SELECT payload FROM welding_orders')],'welders':WELDERS}
    if path=='/api/welding/preview':
        r=c.execute('SELECT content FROM welding_files WHERE id=?',(body.get('id'),)).fetchone()
        if not r:return 404,{'error':'PDF не знайдено.'}
        try:
            import io
            import pypdfium2 as pdfium
            pdf=pdfium.PdfDocument(r['content'])
            try:
                page=pdf[0]
                try:
                    bitmap=page.render(scale=min(1400/page.get_width(),1000/page.get_height()))
                    try:
                        out=io.BytesIO();bitmap.to_pil().save(out,format='PNG')
                    finally:bitmap.close()
                finally:page.close()
            finally:pdf.close()
            return 200,{'data':base64.b64encode(out.getvalue()).decode()}
        except Exception:return 422,{'error':'Передперегляд недоступний. Натисніть назву, щоб відкрити PDF.'}
    if path=='/api/welding/file':
        r=c.execute('SELECT name,content FROM welding_files WHERE id=?',(body.get('id'),)).fetchone()
        return (200,{'name':r['name'],'data':base64.b64encode(r['content']).decode()}) if r else (404,{'error':'PDF не знайдено.'})
    if path=='/api/welding/create':
        if role not in ('manager','chief','admin'):return 403,{'error':'Замовлення створює менеджер.'}
        request_id=body.get('requestId','')
        if len(request_id)!=32 or any(ch not in '0123456789abcdef' for ch in request_id):raise ValueError('Некоректний ідентифікатор запиту.')
        existing=c.execute('SELECT payload FROM welding_orders WHERE id=?',(request_id,)).fetchone()
        if existing:
            o=json.loads(existing['payload'])
            return (200,o) if o['manager']==actor else (403,{'error':'Чуже замовлення.'})
        o={**fields(body),'id':request_id,'manager':actor,'created':now(),'status':'queued','welder':'','reason':'','version':1,'files':[],'history':[]}
        action='Створено замовлення'
    else:
        row=c.execute('SELECT payload FROM welding_orders WHERE id=?',(body.get('id'),)).fetchone()
        if not row:return 404,{'error':'Замовлення не знайдено.'}
        o=json.loads(row['payload'])
        if role=='manager' and o['manager']!=actor and path!='/api/welding/position':return 403,{'error':'Ви можете змінювати лише власні замовлення.'}
        if body.get('version')!=o['version']:return 409,{'error':'Замовлення змінилося. Закрийте вікно, оновіть список і повторіть.'}
        if path=='/api/welding/delete':
            if role not in ('manager','chief','admin'):return 403,{'error':'Видаляти замовлення може менеджер або ADMIN.'}
            c.execute('CREATE TABLE IF NOT EXISTS deleted_orders (department TEXT, id TEXT, payload TEXT, actor TEXT, deleted_at TEXT)')
            c.execute('INSERT INTO deleted_orders VALUES (?,?,?,?,?)',('welding',o['id'],json.dumps(o,ensure_ascii=False),actor,now()))
            c.execute('DELETE FROM welding_orders WHERE id=?',(o['id'],))
            return 200,{'deleted':o['id']}
        if path in ('/api/welding/worker-start','/api/welding/worker-stop'):
            code,result=worker_action(o,path,body,actor,role,now())
            if code!=200:return code,result
            action=result
        elif path=='/api/welding/worker-delete':
            if body.get('chiefPassword')!='0000':return 403,{'error':'Неправильний пароль керівника дільниці.'}
            if role not in ('chief','admin'):return 403,{'error':'Видаляти запис зварювальника може керівник дільниці або ADMIN.'}
            job=next((w for w in o.get('workerJobs',[]) if w['id']==body.get('workerJobId')),None)
            if not job:return 404,{'error':'Запис зварювальника не знайдено.'}
            timestamp=now()
            o.setdefault('deletedWorkerJobs',[]).append(dict(job=job,deletedAt=timestamp,deletedBy=actor))
            o['workerJobs']=[w for w in o['workerJobs'] if w['id']!=job['id']]
            o['assignedWelders']=[n for n in (o.get('assignedWelders') or []) if n!=job['welder']]
            o['welder']=', '.join(o['assignedWelders'])
            update_worker_totals(o,timestamp)
            o['processHoursBy']=actor
            if o['status']!='done':
                if any(w['status']=='working' for w in o['workerJobs']):o.update(status='working',reason='')
                elif any(w['status']=='paused' for w in o['workerJobs']):o.update(status='paused',reason='Роботу зварювальників призупинено')
                elif o['workerJobs']:o.update(status='review',reason='')
                elif o['status']!='internal':o.update(status='queued',reason='')
            action='Видалено запис зварювальника: '+job['welder']
        elif path=='/api/welding/complete':
            if role!='chief' or actor!='Андрій Матуда' or body.get('chiefPassword')!='0000':return 403,{'error':'Завершення підтверджує керівник дільниці своїм паролем.'}
            if o['status']=='done':return 409,{'error':'Замовлення вже виконане.'}
            if any(w['status']!='done' for w in o.get('workerJobs',[])):return 400,{'error':'Спочатку завершіть записи всіх зварювальників.'}
            o.update(status='done',reason='',completed=now(),completedBy=actor)
            action='Керівник підтвердив виконання замовлення'
        elif path=='/api/welding/remove-file':
            fid=body.get('fileId')
            if not any(f['id']==fid for f in o.get('files',[])):return 404,{'error':'Креслення не знайдено в цьому замовленні.'}
            removed=next(f for f in o['files'] if f['id']==fid)
            o['files']=[f for f in o['files'] if f['id']!=fid]
            c.execute('DELETE FROM welding_files WHERE id=? AND order_id=?',(fid,o['id']))
            action='Видалено креслення: '+removed['name']
        elif path=='/api/welding/position':
            if role not in ('manager','chief','admin'):return 403,{'error':'Номер черги змінює менеджер або ADMIN.'}
            position=body.get('position')
            if position in (None,''):position=None
            elif isinstance(position,bool) or not str(position).isdigit() or int(position)<1:raise ValueError('Номер черги має бути цілим числом від 1.')
            else:position=int(position)
            o['queuePosition']=position
            action='Черговість замовлення: '+(str(position) if position else 'не вказана')
        elif path=='/api/welding/process-hours':
            if body.get('complete') is True:return 403,{'error':'Завершіть основне замовлення з підтвердженням паролем керівника.'}
            if o.get('workerJobs'):return 400,{'error':'Години цього замовлення сумуються із записів зварювальників.'}
            if role not in ('chief','admin'):return 403,{'error':'Години вносить керівник дільниці або ADMIN.'}
            if o['status']!='done' and body.get('complete') is not True:return 400,{'error':'Години можна внести лише у виконане замовлення.'}
            values=body.get('processHours')
            if not isinstance(values,dict):raise ValueError('Вкажіть години за процесами.')
            hours={}
            for key in ('welding','support','logistics','other'):
                raw=values.get(key,'')
                try:
                    value=Decimal(str(raw).strip().replace(',','.') or '0')
                    if not value.is_finite() or value<0 or value.as_tuple().exponent < -2:raise ValueError()
                except (InvalidOperation,ValueError):raise ValueError('Години мають бути невід’ємним числом, до двох знаків після коми.')
                hours[key]=str(value)
            # Preserve previously recorded cleaning hours without exposing an editable field.
            if 'cleaning' in o.get('processHours',{}):hours['cleaning']=o['processHours']['cleaning']
            comment=str(body.get('processHoursComment','')).strip()
            if len(comment)>4000:raise ValueError('Коментар: максимум 4000 символів.')
            if Decimal(hours['other'])>0 and not comment:raise ValueError('Для процесу «Інше» додайте коментар.')
            o.update(processHours=hours,processHoursComment=comment,processHoursBy=actor,processHoursAt=now())
            if body.get('complete') is True and o['status']!='done':o.update(status='done',completed=now(),completedBy=actor,reason='')
            action='Збережено години за процесами'
        elif path=='/api/welding/edit':o.update(fields({**o,**body}));action='Змінено дані'
        elif path=='/api/welding/priority':
            o['priority']=priority(body.get('priority'))
            action='Пріоритет: '+o['priority']
        elif path=='/api/welding/assign':
            if role not in ('chief','admin'):return 403,{'error':'Зварювальника призначає керівник дільниці.'}
            selected=body.get('assignedWelders')
            if selected is None:selected=[body['welder']] if body.get('welder') else []
            if not isinstance(selected,list) or any(not isinstance(n,str) or n not in WELDERS for n in selected):raise ValueError('Оберіть зварювальників зі списку.')
            selected=[n for n in WELDERS if n in selected]
            o['assignedWelders']=selected
            o['welder']=', '.join(selected)
            action='Призначено зварювальників: '+(o['welder'] or 'не призначено')
        elif path=='/api/welding/status':
            status=body.get('status')
            if status=='done':return 403,{'error':'Завершення потребує підтвердження паролем керівника.'}
            if o.get('workerJobs') and (any(w['status']=='working' for w in o['workerJobs']) or status in ('working','paused','done')):return 400,{'error':'Змініть стан у записі відповідного зварювальника.'}
            if status=='working' and role in ('chief','admin'):return 400,{'error':'Оберіть зварювальника для початку роботи.'}
            if status=='review' and (not o.get('workerJobs') or any(w['status']!='done' for w in o['workerJobs'])):return 400,{'error':'До перевірки можна передати лише після завершення роботи всіх зварювальників.'}
            if status not in ('internal','queued','working','paused','review','done'):raise ValueError('Некоректний статус.')
            if status=='done' and role in ('chief','admin'):return 400,{'error':'Заповніть години за процесами у вікні завершення.'}
            reason=body.get('reason','') if status=='paused' else ''
            if status=='paused' and reason not in reasons:raise ValueError('Оберіть причину зупинки.')
            o.update(status=status,reason=reason)
            if status=='done':o.update(completed=now(),completedBy=actor)
            else:o.pop('completed',None);o.pop('completedBy',None)
            action='Статус: '+status
        elif path=='/api/welding/files':action='Додано PDF'
        else:return 404,{'error':'Невідома дія.'}
        o['version']+=1
    for fid,name,content in prepare_files(body.get('files',[])):
        c.execute('INSERT INTO welding_files VALUES (?,?,?,?)',(fid,o['id'],name,content))
        o['files'].append(dict(id=fid,name=name))
    o['history'].append(dict(at=now(),actor=actor,action=action))
    save(c,o)
    painting.transfer(c,[o],'welding',now())
    return 200,o
