import json
from datetime import datetime
import welding

def handle(c,body,actor,role,timestamp):
    if role!='admin':return 403,{'error':'Коригувати час може тільки ADMIN.'}
    try:
        h=str(body.get('hours',''));m=str(body.get('minutes',''))
        if not h.isdigit() or not m.isdigit() or int(h)>100000 or int(m)>59:raise ValueError()
        seconds=(int(h)*60+int(m))*60
    except ValueError:return 400,{'error':'Вкажіть години та хвилини (0–59) цілими числами.'}
    reason=str(body.get('reason','')).strip()
    if not reason or len(reason)>2000:return 400,{'error':'Вкажіть причину виправлення (до 2000 символів).'}
    stop=body.get('stop') is True
    def elapsed(o,total,start):
        return float(o.get(total,0) or 0)+(max(0,(datetime.fromisoformat(timestamp)-datetime.fromisoformat(o[start])).total_seconds()) if o.get(start) else 0)
    if body.get('department')=='bending':
        rows=[json.loads(r['payload']) for r in c.execute('SELECT payload FROM orders')]
        first=next((o for o in rows if o['id']==body.get('id')),None)
        if not first:return 404,{'error':'Замовлення не знайдено.'}
        members=[o for o in rows if (o.get('groupId'),o['number'])==(first.get('groupId'),first['number'])]
        if any(body.get('versions',{}).get(o['id'])!=o['version'] for o in members):return 409,{'error':'Замовлення змінилось. Відкрийте коригування повторно.'}
        for o in members:
            before=elapsed(o,'workSeconds','workStartedAt')
            if stop and o['status']=='working':o.update(status='paused',reason='Інше',stopComment='ADMIN: '+reason)
            o.update(workSeconds=seconds,workStartedAt=timestamp if o['status']=='working' else None,version=o['version']+1)
            o.setdefault('history',[]).append(dict(at=timestamp,actor=actor,action='Виправлено фактичний час',beforeSeconds=before,afterSeconds=seconds,reason=reason))
            c.execute('UPDATE orders SET payload=? WHERE id=?',(json.dumps(o,ensure_ascii=False),o['id']))
        return 200,{'orders':members}
    if body.get('department')!='welding':return 400,{'error':'Невідома дільниця.'}
    row=c.execute('SELECT payload FROM welding_orders WHERE id=?',(body.get('id'),)).fetchone()
    if not row:return 404,{'error':'Замовлення не знайдено.'}
    o=json.loads(row['payload'])
    if body.get('version')!=o['version']:return 409,{'error':'Замовлення змінилось. Відкрийте коригування повторно.'}
    job=next((j for j in o.get('workerJobs',[]) if j['id']==body.get('workerJobId')),None)
    if not job:return 404,{'error':'Запис зварювальника не знайдено.'}
    hours,comment=welding.worker_hours(body)
    before=dict(elapsedSeconds=elapsed(job,'elapsedSeconds','startedAt'),processHours=job.get('processHours',{}).copy())
    # Store adjustment as an additional signed delta, retaining original intervals.
    from decimal import Decimal
    delta={k:str(Decimal(hours[k])-Decimal(job.get('processHours',{}).get(k,'0'))) for k in welding.PROCESS_KEYS}
    job.setdefault('segments',[]).append(dict(id=__import__('uuid').uuid4().hex,startedAt=None,stoppedAt=timestamp,elapsedSeconds=0,processHours=delta,comment=comment,status=job['status'],actor=actor,adjustment=True,reason=reason))
    if stop and job['status']=='working':job['status']='paused'
    job.update(elapsedSeconds=seconds,startedAt=timestamp if job['status']=='working' else None)
    if o['status']!='done':
        if any(j['status']=='working' for j in o['workerJobs']):o.update(status='working',reason='')
        elif any(j['status']=='paused' for j in o['workerJobs']):o.update(status='paused',reason='Роботу зварювальників призупинено')
        else:o.update(status='review',reason='')
    welding.update_worker_totals(o,timestamp)
    o['version']+=1
    o.setdefault('history',[]).append(dict(at=timestamp,actor=actor,action='Виправлено час: '+job['welder'],before=before,afterSeconds=seconds,afterProcessHours=hours,reason=reason))
    welding.save(c,o)
    return 200,{'order':o}
