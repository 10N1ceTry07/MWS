"""Department suggestions, stored separately from production orders."""
import uuid
ACCESS={'laser':{'laser_chief','manager','admin'},'bending':{'operator','manager','admin'},'welding':{'chief','manager','admin'},'painting':{'painting_chief','manager','admin'}}
def handle(c,path,body,actor,role,now):
    department=body.get('department')
    if role not in ACCESS.get(department,set()):return 403,{'error':'Немає доступу до нотаток цієї дільниці.'}
    c.execute('CREATE TABLE IF NOT EXISTS department_notes (id TEXT PRIMARY KEY, department TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL)')
    if path=='/api/notes/count':
        return 200,{'count':c.execute('SELECT count(*) FROM department_notes WHERE department=?',(department,)).fetchone()[0]}
    if path=='/api/notes/delete':
        if role!='admin':return 403,{'error':'Видаляти нотатки може тільки ADMIN.'}
        c.execute('DELETE FROM department_notes WHERE id=? AND department=?',(body.get('id'),department))
    elif path=='/api/notes/add':
        text=body.get('text')
        if not isinstance(text,str) or not text.strip() or len(text)>4000:return 400,{'error':'Введіть нотатку від 1 до 4000 символів.'}
        try:note_id=str(uuid.UUID(body.get('requestId','')))
        except (ValueError,TypeError,AttributeError):return 400,{'error':'Некоректний ідентифікатор нотатки.'}
        author='Оператор' if role=='operator' else actor
        previous=c.execute('SELECT * FROM department_notes WHERE id=?',(note_id,)).fetchone()
        if previous and (previous['department']!=department or previous['actor']!=author or previous['role']!=role or previous['text']!=text.strip()):return 409,{'error':'Нотатка вже існує. Відкрийте вікно повторно.'}
        c.execute('INSERT OR IGNORE INTO department_notes VALUES (?,?,?,?,?,?)',(note_id,department,author,role,text.strip(),now()))
    elif path!='/api/notes/list':return 404,{'error':'Невідома дія.'}
    return 200,{'notes':[dict(r) for r in c.execute('SELECT * FROM department_notes WHERE department=? ORDER BY created DESC, id DESC',(department,))]}
