'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const priorities = {urgent:'Терміновий',high:'Підвищений',normal:'Звичайний'};
const statuses = {internal:'Внутрішнє',queued:'У черзі',working:'У роботі',paused:'Призупинено',done:'Виконано'};
const rank = {urgent:0,high:1,normal:2};
const fmt = value => value ? new Date(value).toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
const day = value => value ? value.split('-').reverse().join('.') : '—';
const staff={manager:['Артем Кузнеченко','Богдан Зазуляк','Денис Стадник','Тарас Рибачук'],operator:['Оператор'],chief:['Андрій Матуда'],laser_chief:['Михайлишин Володимир'],painting_chief:['Роман Мустаєв'],admin:['ADMIN']};
let profile = null;
try { profile = JSON.parse(sessionStorage.getItem('bending-profile')); } catch {}
if(!staff[profile?.role]?.includes(profile?.name)||(profile?.role!=='operator'&&!profile.token))profile=null;
let sortColumn=null,sortDirection=1;
let orders=[], filter='all', archive=false, editing=null, detail=null, stopping=null, toastTimer, fetching=false;
let extractGeneration=0;
const pdfNote=document.createElement('div');pdfNote.id='pdfNote';pdfNote.className='muted prewrap';pdfNote.setAttribute('role','status');$('#selectedFiles').after(pdfNote);
function toast(message) { $('#toast').textContent=message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),6000); }
function applyProfile() {
  document.body.classList.toggle('operator',profile?.role==='operator');
  $('#profileName').textContent=profile?.name||'Оберіть профіль';
  $('#profileRole').textContent=profile?.role==='operator'?'Оператор':['chief','painting_chief','laser_chief'].includes(profile?.role)?'Керівник дільниці':profile?.role==='admin'?'Адміністратор':'Менеджер';
  $('#avatar').textContent=profile?.name?.[0]?.toUpperCase()||'?';
  render();
  window.dispatchEvent(new Event('profile-changed'));
}
function fillStaff(){const f=$('#profileForm'),names=staff[f.elements.role.value];$('#managerPassword').hidden=f.elements.role.value==='operator';f.elements.password.required=f.elements.role.value!=='operator';f.elements.password.value='';$('#profileError').textContent='';f.elements.name.innerHTML=names.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');if(names.includes(profile?.name))f.elements.name.value=profile.name;}
$('#profileForm').elements.role.addEventListener('change',fillStaff);
function showProfile(){const f=$('#profileForm');f.elements.role.value=profile?.role||'manager';fillStaff();$('#profileDialog').showModal();}

$('#profileForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,button=e.submitter;button.disabled=true;$('#profileError').textContent='';try{const next={name:f.elements.name.value,role:f.elements.role.value};if(next.role!=='operator'){const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor:next.name,role:next.role,password:f.elements.password.value})});const data=await r.json();if(!r.ok)throw Error(data.error);next.token=data.token;}profile=next;sessionStorage.setItem('bending-profile',JSON.stringify(profile));f.elements.password.value='';$('#profileDialog').close();applyProfile();}catch(err){$('#profileError').textContent=err.message;}finally{button.disabled=false;}});
$('#profileDialog').addEventListener('cancel',e=>{if(!profile)e.preventDefault();});
$('#profileBtn').onclick=showProfile;
async function refresh(){
  if(fetching)return; fetching=true;
  try {const res=await fetch('/api/orders'); if(!res.ok)throw Error(); orders=await res.json(); render(); $('#connection').innerHTML='<span class="dot"></span> Локально · підключено';
    if(detail && $('#detailDialog').open){const updated=orders.find(o=>o.id===detail.id); if(updated && updated.version!==detail.version){detail=updated;renderDetail();}}
  } catch {$('#connection').textContent='Немає зв’язку із сервером';} finally {fetching=false;}
}
async function post(path,body){
  if(!profile)throw Error('Оберіть робочий профіль.');
  let res; try{res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,actor:profile.name,role:profile.role,token:profile.token})});}catch{throw Error('Немає зв’язку із сервером. Перевірте, чи запущена програма.');}
  const data=await res.json(); if(!res.ok)throw Error(data.error||'Не вдалося зберегти.');
  const i=orders.findIndex(o=>o.id===data.id); if(i<0)orders.push(data);else orders[i]=data; render(); return data;
}
function badge(type,text){return `<span class="badge ${type}">${esc(text)}</span>`;}
let groupDetailId=null;
function groupKey(o){return (o.groupId||'legacy')+'|'+o.number;}
function groupedOrders(){
  const map=new Map();for(const o of orders){const key=groupKey(o);if(!map.has(key))map.set(key,[]);map.get(key).push(o);}
  return [...map.values()].map(parts=>{
    parts.sort((a,b)=>a.created.localeCompare(b.created));
    const status=parts.some(o=>o.status==='internal')?'internal':parts.some(o=>o.status==='paused')?'paused':parts.some(o=>o.status==='working')?'working':parts.some(o=>o.status==='queued')?'queued':'done';
    const priority=[...parts].sort((a,b)=>rank[a.priority]-rank[b.priority])[0].priority;
    return {id:parts[0].id,number:parts[0].number,created:parts[0].created,parts,status,priority,due:parts.map(o=>o.due).filter(Boolean).sort()[0]||'',completed:parts.map(o=>o.completed||'').sort().at(-1)};
  });
}
function ownsOrder(parts){return profile?.role==='admin'||profile?.role==='manager'&&parts.every(o=>o.manager===profile.name);}
function canChangeStatus(parts){return profile?.role==='operator'||ownsOrder(parts);}
function completedBy(o){return o.completedBy||[...(o.history||[])].reverse().find(h=>h.action==='Завершив замовлення'||h.action==='Статус усього замовлення: Виконано')?.actor||'Не зафіксовано';}
document.querySelector('main .stats').insertAdjacentHTML('afterend',`<div id="bendingTotals" class="bending-totals"><div class="stat"><span>Загальна сума активних замовлень</span><strong id="bendingTotalCost">0 грн</strong><small id="bendingCostNote">Кожне замовлення враховано один раз</small></div><div class="stat"><span>Очікуваний час гнуття</span><strong id="bendingExpectedTime">0 год 0 хв</strong><small id="bendingExpectedNote">Оцінка за вартістю: сума ÷ 1 500 грн/год</small></div><div class="stat"><span>Фактичний час гнуття</span><strong id="bendingActualTime">0 год 0 хв</strong><small>Час роботи над активними замовленнями, без пауз</small></div></div>`);
$('#bendingTotals').insertAdjacentHTML('afterend',`<div id="completedBendingTotals" class="completed-bending-totals" hidden>${[['ExpectedToday','Очікуваний час сьогодні'],['ActualToday','Фактичний час сьогодні'],['ExpectedMonth','Очікуваний час місяць'],['ActualMonth','Фактичний час місяць']].map(([id,title])=>`<div class="stat"><span>${title}</span><strong id="completed${id}">0 год 0 хв</strong><small id="completed${id}Note"></small>${id.startsWith('Actual')?`<div id="completed${id}Deviation"></div>`:''}</div>`).join('')}</div>`);
$('#completedBendingTotals').insertAdjacentHTML('afterend',`<section id="completedManagerStats" hidden><h3>Очікуваний час за менеджерами</h3><div id="completedManagerRows" class="manager-time-cards"></div></section>`);
function managerCompletedStats(groups,now=Date.now()){
 const names=[...new Set([...staff.manager,...groups.map(g=>g.parts[0]?.manager).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'uk'));
 return names.map(name=>({name,totals:completedBendingStats(groups.filter(g=>g.parts[0]?.manager===name),now)}));
}
function managerActiveStats(groups){
 const names=[...new Set([...staff.manager,...groups.map(g=>g.parts[0]?.manager).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'uk'));
 return names.map(name=>{
  const total={count:0,cents:0,missing:0};
  for(const g of groups){
   if(g.parts[0]?.manager!==name||!['internal','queued','paused','working'].includes(g.status))continue;
   total.count++;
   const raw=g.parts.find(o=>o.bendingCost!==undefined&&o.bendingCost!==null&&o.bendingCost!=='')?.bendingCost;
   const cost=Number(raw);
   if(raw===undefined||!Number.isFinite(cost)||cost<0)total.missing++;else total.cents+=Math.round(cost*100);
  }
  return {name,totals:{Month:total}};
 });
}
function renderCompletedManagerStats(groups){
 const admin=profile?.role==='admin';
 const visible=(admin||archive&&profile?.role==='manager')&&(!archive||completedMonth()!=='undated');
 $('#completedManagerStats').hidden=!visible;if(!visible)return;
 $('#completedManagerStats h3').textContent=archive?'Час гнуття за менеджерами · виконані за місяць':'Очікуваний час за менеджерами · активні замовлення';
 const metric=(t,label)=>{const minutes=Math.round(t.cents/100/1500*60);return `<div class="manager-time-metric"><span>${label}</span><strong>${Math.floor(minutes/60)} год ${minutes%60} хв</strong><small>Замовлень: ${t.count}${t.missing?` · Без вартості: ${t.missing}`:''}</small></div>`;};
 const actual=t=>{const seconds=Math.floor(t.seconds);return `<div class="manager-time-metric"><span>Фактичний час місяць</span><strong>${Math.floor(seconds/3600)} год ${Math.floor(seconds/60)%60} хв</strong><small>Час завершених замовлень без пауз</small></div>`;};
 const html=(archive?managerCompletedStats(groups,completedPeriodNow()):managerActiveStats(groups)).map(({name,totals})=>`<article class="stat manager-time-card"><h4>${esc(name)}</h4>${metric(totals.Month,archive?'Очікуваний час місяць':'Очікуваний час активних замовлень')}${admin&&archive?actual(totals.Month):''}</article>`).join('');
 if($('#completedManagerRows').innerHTML!==html)$('#completedManagerRows').innerHTML=html;
}
$('#search').insertAdjacentHTML('afterend','<select id="completedMonthFilter" aria-label="Архів виконаних замовлень" hidden><option value="current">Виконані — поточний місяць</option></select>');
$('#completedMonthFilter').addEventListener('change',render);
function completedMonth(){const v=$('#completedMonthFilter').value;return v==='current'?kyivDateKey(Date.now()).slice(0,7):v;}
function completedPeriodNow(){const v=$('#completedMonthFilter').value;if(v==='current'||v==='undated')return Date.now();const [y,m]=v.split('-').map(Number);return Date.UTC(y,m,0,12);}
function updateCompletedArchive(groups){
 const select=$('#completedMonthFilter'),previous=select.value,current=kyivDateKey(Date.now()).slice(0,7);
 const months=[...new Set(groups.filter(g=>g.status==='done'&&g.completed).map(g=>kyivDateKey(g.completed).slice(0,7)).filter(m=>m&&m!==current))].sort().reverse();
 const html='<option value="current">Виконані — поточний місяць</option>'+months.map(m=>`<option value="${m}">Архів — ${m.slice(5)}.${m.slice(0,4)}</option>`).join('')+(groups.some(g=>g.status==='done'&&!g.completed)?'<option value="undated">Архів — без дати завершення</option>':'');
 if(select.innerHTML!==html){select.innerHTML=html;select.value=[...select.options].some(o=>o.value===previous)?previous:'current';}select.hidden=!archive;
}
function inCompletedPeriod(g){return g.status==='done'&&(completedMonth()==='undated'?!g.completed:!!g.completed&&kyivDateKey(g.completed).slice(0,7)===completedMonth());}
function kyivDateKey(value){
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kiev',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
 const part=type=>parts.find(p=>p.type===type).value;return `${part('year')}-${part('month')}-${part('day')}`;
}
function completedBendingStats(groups,now=Date.now()){
 const today=kyivDateKey(now),month=today.slice(0,7);
 const totals={Today:{count:0,cents:0,seconds:0,missing:0},Month:{count:0,cents:0,seconds:0,missing:0}};
 for(const g of groups){
  if(g.status!=='done'||!g.completed)continue;
  const date=kyivDateKey(g.completed);if(!date||date>today||date.slice(0,7)!==month)continue;
  const raw=g.parts.find(o=>o.bendingCost!==undefined&&o.bendingCost!==null&&o.bendingCost!=='')?.bendingCost;
  const cost=Number(raw),valid=raw!==undefined&&Number.isFinite(cost)&&cost>=0;
  for(const period of date===today?['Today','Month']:['Month']){const t=totals[period];t.count++;t.seconds+=orderWorkSeconds(g);if(valid)t.cents+=Math.round(cost*100);else t.missing++;}
 }
 return totals;
}
function renderCompletedBendingTotals(groups){
 renderCompletedManagerStats(groups);
 $('#completedBendingTotals').hidden=!archive||completedMonth()==='undated';if(!archive||completedMonth()==='undated')return;
 const totals=completedBendingStats(groups,completedPeriodNow());
 for(const id of ['completedExpectedToday','completedActualToday'])$('#'+id).closest('.stat').hidden=$('#completedMonthFilter').value!=='current';
 for(const period of ['Today','Month']){
  const t=totals[period],minutes=Math.round(t.cents/100/1500*60),seconds=Math.floor(t.seconds);
  $('#completedExpected'+period).textContent=`${Math.floor(minutes/60)} год ${minutes%60} хв`;
  $('#completedActual'+period).textContent=`${Math.floor(seconds/3600)} год ${Math.floor(seconds/60)%60} хв`;
  const note=`Завершено замовлень: ${t.count}.`;
  $('#completedExpected'+period+'Note').textContent=note+(t.missing?` Без вартості: ${t.missing} (не включено в оцінку).`:'');
  $('#completedActual'+period+'Note').textContent=note+' Час роботи без пауз.';
  const delta=Math.round(seconds/60)-minutes,duration=n=>`${Math.floor(n/60)} год ${n%60} хв`;
  const deviation=!t.count?'':t.missing?'<span class="time-deviation time-match">Порівняння неповне: вкажіть вартість усіх завершених замовлень.</span>':delta>0?`<span class="time-deviation time-over">⚠ Довше розрахунку на ${duration(delta)}</span>`:delta<0?`<span class="time-deviation time-under">Швидше розрахунку на ${duration(-delta)}</span>`:'<span class="time-deviation time-match">За розрахунковим часом (до хвилини)</span>';
  $('#completedActual'+period+'Deviation').innerHTML=deviation;
 }
}
function renderBendingTotals(groups){
 const active=groups.filter(g=>g.status!=='done');let cents=0,missing=0;
 for(const g of active){const raw=g.parts.find(o=>o.bendingCost!==undefined&&o.bendingCost!==null&&o.bendingCost!=='')?.bendingCost;const cost=Number(raw);if(raw===undefined||!Number.isFinite(cost)||cost<0){missing++;continue;}cents+=Math.round(cost*100);}
 const minutes=Math.round(cents/100/1500*60);
 $('#bendingTotalCost').textContent=(cents/100).toLocaleString('uk-UA',{maximumFractionDigits:2})+' грн';
 $('#bendingExpectedTime').textContent=`${Math.floor(minutes/60)} год ${minutes%60} хв`;
 $('#bendingCostNote').textContent=`Активних замовлень: ${active.length}. Без вказаної вартості: ${missing}.`;
 const operator=profile?.role==='operator';
 $('#bendingTotalCost').closest('.stat').hidden=profile?.role!=='admin';
 $('#bendingTotals').classList.toggle('operator-totals',profile?.role!=='admin');
 $('#bendingExpectedNote').textContent=operator?'Розрахунковий час активних замовлень':'Оцінка за вартістю: сума ÷ 1 500 грн/год';
 renderActualBendingTime(groups);
 $('#bendingTotals').hidden=archive;
}
$('#search').insertAdjacentHTML('afterend','<select id="managerFilter" aria-label="Фільтр за менеджером"><option value="">Усі менеджери</option></select>');
$('#managerFilter').addEventListener('change',render);
function render(){
  const groups=groupedOrders();
  updateCompletedArchive(groups);
  renderBendingTotals(groups);
  renderCompletedBendingTotals(groups);
  $('#sQueued').textContent=groups.filter(g=>g.status==='queued').length;
  $('#sWorking').textContent=groups.filter(g=>g.status==='working').length;
  $('#sPaused').textContent=groups.filter(g=>g.status==='paused').length;
  $('#sDone').textContent=groups.filter(g=>g.status==='done').length;
  $('#navCount').textContent=groups.filter(g=>g.status!=='done').length;
  const managerSelect=$('#managerFilter'),selectedManager=managerSelect.value;
  const managerNames=[...new Set([...staff.manager,...orders.map(o=>o.manager).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'uk'));
  const managerOptions='<option value="">Усі менеджери</option>'+managerNames.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');
  if(managerSelect.dataset.options!==managerOptions){managerSelect.innerHTML=managerOptions;managerSelect.dataset.options=managerOptions;managerSelect.value=selectedManager;}
  const q=$('#search').value.trim().toLocaleLowerCase('uk-UA');
  const visible=groups.filter(g=>(!managerSelect.value||g.parts.some(o=>o.manager===managerSelect.value))&&(archive?inCompletedPeriod(g):g.status!=='done')&&(archive||filter==='all'||g.status===filter)&&g.parts.some(o=>(!q||[o.number,o.title,o.manager,o.material].join(' ').toLocaleLowerCase('uk-UA').includes(q)))).sort(compareOrders);
  $('[data-sort=position]').closest('th').hidden=archive;
  $('#workTimeHeading').hidden=!archive;
  $('#completedByHeading').hidden=!archive;
  $('#rows').innerHTML=visible.map(g=>`<tr>${archive?'':`<td>${['manager','admin'].includes(profile?.role)?`<input class="queue-position" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="Номер черги" data-position="${g.id}" value="${g.parts[0].queuePosition??''}">`:esc(g.parts[0].queuePosition??'—')}</td>`}<td><button class="order-link" data-group="${g.id}">${esc(g.number)}</button></td><td>${g.parts.length} ${partTypeLabel(g.parts.length)}<span class="sub">${g.parts.reduce((n,o)=>n+o.quantity,0)} шт. разом</span><span class="sub">Орієнтовний час: ${esc(orderExpectedTime(g.parts.find(o=>o.bendingCost!==undefined&&o.bendingCost!==null&&o.bendingCost!=='')||g.parts[0]))}</span></td><td>${orderPrioritySelect(g)}</td><td>${day(g.due)}</td><td>${orderStatusSelect(g,!archive)}${[...new Set(g.parts.filter(o=>o.reason).map(o=>o.reason))].map(r=>`<span class="reason-text">${esc(r)}</span>`).join('')}</td>${archive?`<td class="completed-work-time">${workTimer(g)}</td>`:''}${archive?`<td>${esc([...new Set(g.parts.map(completedBy))].join(', '))}<span class="sub" title="Дата й час завершення">${fmt(g.completed)}</span></td>`:''}<td>${esc([...new Set(g.parts.map(o=>o.manager))].join(', '))}<span class="sub">${fmt(g.created)}</span></td></tr>`).join('');
  $('#empty').hidden=visible.length>0;
  const trulyEmpty=!groups.some(g=>archive?inCompletedPeriod(g):g.status!=='done');
  $('#empty h2').textContent=trulyEmpty?(archive?'Виконаних замовлень поки немає':'Черга поки порожня'):'Замовлень не знайдено';
  $('#empty p').textContent=trulyEmpty?(archive?'Тут з’являться повністю виконані замовлення.':'Додайте замовлення та завантажте його креслення.'):'Спробуйте змінити пошук або фільтри.';
  $('#emptyAdd').hidden=archive||!['manager','admin'].includes(profile?.role)||!trulyEmpty;
  const statusButton=$('[data-sort=status]');statusButton.textContent='СТАТУС '+(sortColumn==='status'?(sortDirection===1?'↑':'↓'):'↕');statusButton.closest('th').setAttribute('aria-sort',sortColumn==='status'?(sortDirection===1?'ascending':'descending'):'none');
  const managerButton=$('[data-sort=manager]');managerButton.textContent='МЕНЕДЖЕР / ВНЕСЕНО '+(sortColumn==='manager'?(sortDirection===1?'↑':'↓'):'↕');
  $('#resultCount').textContent=`Замовлень: ${visible.length}`;
  if(groupDetailId&&$('#groupDialog')?.open&&!document.activeElement?.closest('#deadlineForm, #costForm'))renderGroup();
}
function materialKey(o){return JSON.stringify([o.material.trim().replace(/\s+/g,' ').toLocaleLowerCase('uk-UA'),Number(o.thickness)]);}
function renderGroup(){
  const first=orders.find(o=>o.id===groupDetailId);if(!first)return;
  const expanded=new Set([...document.querySelectorAll('#groupContent details[open]')].map(el=>el.dataset.materialKey));
  const parts=orders.filter(o=>groupKey(o)===groupKey(first));
  const buckets=new Map();
  for(const o of parts){const key=materialKey(o);if(!buckets.has(key))buckets.set(key,{key,material:o.material.trim(),thickness:Number(o.thickness),parts:[]});buckets.get(key).parts.push(o);}
  const groups=[...buckets.values()].sort((a,b)=>a.material.localeCompare(b.material,'uk',{sensitivity:'base',numeric:true})||a.thickness-b.thickness);
  $('#groupContent').innerHTML=`<div class="dialog-heading"><div><div class="eyebrow">ЗАМОВНИК</div><h2>${esc(first.number)}</h2></div><button class="icon-btn" data-close="groupDialog" aria-label="Закрити">×</button></div><div class="order-controls">Статус замовлення: ${orderStatusSelect(groupedOrders().find(g=>g.id===first.id)||groupedOrders().find(g=>g.parts.some(o=>o.id===first.id)))}</div>${orderStopComments(parts)}${[...new Set(parts.map(o=>o.noPdfReason).filter(Boolean))].map(reason=>`<div class="callout"><b>Причина додавання без PDF</b><div class="prewrap">${esc(reason)}</div></div>`).join('')}${deadlineControls(first)}${ownsOrder(parts)?`<label class="transfer-choice"><input type="checkbox" data-transfer="${first.id}" ${parts.some(o=>o.sendToWelding)?'checked':''}> Після гнуття передати на зварювання</label>`:''}${costControls(first,parts)}<p>Розрахунковий час гнуття замовлення: <b id="orderExpectedTime">${orderExpectedTime(first)}</b><span class="sub">За вартістю замовлення ÷ 1 500 грн/год</span></p>${stopPhotoGallery(parts)}<p class="muted">Груп: ${groups.length} · Деталей: ${parts.length} · ${parts.reduce((n,o)=>n+o.quantity,0)} шт. разом. Розгорніть матеріал і товщину, щоб відкрити креслення.</p><div class="material-groups">${groups.map(g=>{
    const done=g.parts.filter(o=>o.status==='done').length;
    const status=g.parts.some(o=>o.status==='paused')?'paused':g.parts.some(o=>o.status==='working')?'working':done===g.parts.length?'done':'queued';
    g.parts.sort((a,b)=>a.title.localeCompare(b.title,'uk',{numeric:true}));
    return `<details class="material-group" data-material-key="${esc(g.key)}" ${expanded.has(g.key)?'open':''}><summary><span class="material-heading"><strong>${esc(g.material)}</strong><span class="thickness-tag">${g.thickness.toLocaleString('uk-UA')} мм</span></span><span>${g.parts.length} деталей · <b>${g.parts.reduce((n,o)=>n+o.quantity,0)} шт.</b></span></summary><div class="table-wrap"><table><thead><tr><th>ДЕТАЛЬ</th><th>КІЛЬКІСТЬ</th><th></th></tr></thead><tbody>${g.parts.map(o=>`<tr><td>${o.files.length?`<a class="order-link" data-preview="${o.id}" href="/files/${o.files[0].id}" target="_blank" rel="noopener">${esc(o.title)}</a>`:`<span>${esc(o.title)}</span>`}</td><td>${o.quantity} шт.</td><td><button class="secondary small-btn" data-open="${o.id}">Дані деталі →</button></td></tr>`).join('')}</tbody></table></div></details>`;
  }).join('')}</div>${ownsOrder(parts)?`<div class="dialog-actions"><button type="button" class="danger" data-delete-order="${first.id}">Видалити замовлення</button></div>`:''}`;
}
document.body.insertAdjacentHTML('beforeend','<dialog id="groupDialog" class="wide" style="width:1100px"><div id="groupContent"></div></dialog>');
document.addEventListener('click',e=>{const button=e.target.closest('[data-group]');if(button){groupDetailId=button.dataset.group;renderGroup();$('#groupDialog').showModal();}});
function setArchive(value){archive=value;filter='all';$('#queueNav').classList.toggle('active',!value);$('#archiveNav').classList.toggle('active',value);$('#pageTitle').textContent=value?'Виконані замовлення':'Черга гнуття';$('#tabs').style.visibility=value?'hidden':'visible';$('#subtitle').textContent=value?'Історія завершених робіт та їхні креслення.':'Усі замовлення, креслення та стан роботи — в одному місці.';document.querySelectorAll('[data-status]').forEach(b=>b.classList.toggle('selected',b.dataset.status==='all'));render();}
$('#queueNav').onclick=()=>setArchive(false);$('#archiveNav').onclick=()=>setArchive(true);
$('#tabs').onclick=e=>{const b=e.target.closest('[data-status]');if(!b)return;filter=b.dataset.status;document.querySelectorAll('[data-status]').forEach(el=>el.classList.toggle('selected',el===b));render();};
$('#search').addEventListener('input',render);
$('#refreshBtn').onclick=refresh;
function fileLinks(files){return files.map(f=>`<a href="/files/${f.id}" target="_blank" rel="noopener">▧ ${esc(f.name)} <span class="muted">· ${(f.size/1024/1024).toFixed(2)} МБ · ${fmt(f.added)}</span></a>`).join('');}
function openEdit(order=null){
  extractGeneration++;pdfNote.textContent='Назву деталі й товщину спробуємо зчитати з PDF. Усі поля можна заповнити вручну.';
  if(!profile){showProfile();return;} if(!['manager','admin'].includes(profile.role))return;
  editing=order?structuredClone(order):null;const f=$('#editForm');f.reset();$('#editError').textContent='';$('#selectedFiles').textContent='';$('#existingFiles').innerHTML=order?fileLinks(order.files):'';$('#editTitle').textContent=order?'Редагувати замовлення':'Нове замовлення';
  if(order)for(const name of ['number','title','material','thickness','quantity','priority','due','comment'])f.elements[name].value=order[name];
  colorPriorityFields();$('#editDialog').showModal();
}
$('#newBtn').onclick=()=>openEdit();$('#emptyAdd').onclick=()=>openEdit();
$('#editDialog').addEventListener('close',()=>{extractGeneration++;});
$('#pdfInput').onchange=async()=>{
  const generation=++extractGeneration;
  $('#selectedFiles').textContent=[...$('#pdfInput').files].map(f=>f.name).join(', ');
  if(!$('#pdfInput').files.length){pdfNote.textContent='Дані можна ввести вручну.';return;}
  pdfNote.textContent='Зчитуємо назву деталі й товщину з PDF…';
  const form=$('#editForm');
  try{
    const files=await getFiles();
    if(generation!==extractGeneration)return;
    const response=await fetch('/api/extract-pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files,actor:profile.name,role:profile.role,token:profile.token})});
    const data=await response.json();if(!response.ok)throw Error(data.error||'Не вдалося прочитати PDF.');
    if(generation!==extractGeneration)return;
    const titles=[...new Set(data.files.flatMap(f=>f.titles))],thicknesses=[...new Set(data.files.flatMap(f=>f.thicknesses))];
    const messages=[];
    for(const [field,values,label] of [['title',titles,'Назва деталі'],['thickness',thicknesses,'Товщина, мм']]){
      if(values.length===1){
        if(!form.elements[field].value.trim()){form.elements[field].value=values[0];messages.push(`${label}: ${values[0]} — підставлено з PDF, перевірте значення.`);}
        else messages.push(`${label} у PDF: ${values[0]}. Ваше введене значення залишено.`);
      }else if(values.length>1)messages.push(`${label}: знайдено різні значення (${values.join('; ')}). Оберіть і введіть потрібне вручну.`);
      else messages.push(`${label}: не знайдено. Введіть вручну.`);
    }
    messages.push(...data.files.filter(f=>f.message).map(f=>`${f.name}: ${f.message}`));pdfNote.textContent=messages.join('\n');
  }catch(err){if(generation===extractGeneration)pdfNote.textContent=err.message+' Поля можна заповнити вручну.';}
};
async function getFiles(){const files=[...$('#pdfInput').files];return Promise.all(files.map(async f=>{if(!f.name.toLowerCase().endsWith('.pdf'))throw Error('Потрібні PDF-файли.');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(Error('Не вдалося прочитати файл.'));r.readAsDataURL(f);});return {name:f.name,data};}));}
$('#editForm').onsubmit=async e=>{e.preventDefault();const submit=e.submitter;submit.disabled=true;$('#editError').textContent='';try{const body=Object.fromEntries(new FormData(e.target));body.files=await getFiles();if(editing){body.action='edit';body.version=editing.version;}const saved=await post('/api/orders'+(editing?'/'+editing.id:''),body);$('#editDialog').close();if($('#detailDialog').open){detail=saved;renderDetail();}toast(editing?'Зміни збережено':'Замовлення додано до черги');}catch(err){$('#editError').textContent=err.message;}finally{submit.disabled=false;}};
function openDetail(id){detail=orders.find(o=>o.id===id);if(!detail)return;renderDetail();$('#detailDialog').showModal();}
function renderDetail(){const o=detail;const manager=ownsOrder([o]);const editable=profile?.role==='admin'||manager&&['queued','paused'].includes(o.status);let actions='';

  $('#detailContent').innerHTML=`<div class="dialog-heading"><div><div class="eyebrow">ЗАМОВНИК: ${esc(o.number)}</div><h2 class="prewrap">${esc(o.title)}</h2></div><button class="icon-btn" data-close="detailDialog" aria-label="Закрити">×</button></div>${badge(o.priority,priorities[o.priority])}<div class="detail-grid"><div><small>МАТЕРІАЛ</small><strong>${esc(o.material)}</strong></div><div><small>ТОВЩИНА</small><strong>${o.thickness} мм</strong></div><div><small>КІЛЬКІСТЬ</small><strong>${o.quantity} шт.</strong></div></div>${o.operator?`<p class="muted">Оператор: ${esc(o.operator)}</p>`:''}${o.reason?`<div class="callout"><b>Причина зупинки: ${esc(o.reason)}</b>${o.stopComment?'\n'+esc(o.stopComment):''}</div>`:''}${o.comment?`<p class="prewrap">${esc(o.comment)}</p>`:''}<div class="section-title">PDF-креслення · ${o.files.length}</div><div class="file-list">${o.files.length?fileLinks(o.files):'<p class="muted">Креслення ще не додано.</p>'}</div>${manager&&o.status==='working'?'<p class="muted">Щоб змінити дані або креслення, оператор має спершу призупинити роботу.</p>':''}<div class="dialog-actions">${editable?'<button class="secondary" id="editBtn">Редагувати</button>':''}${actions}</div>`;
  if($('#editBtn'))$('#editBtn').onclick=()=>openEdit(detail);
  if($('#pauseBtn'))$('#pauseBtn').onclick=()=>{stopping=structuredClone(detail);$('#stopForm').reset();$('#stopForm').elements.stopComment.required=false;$('#stopError').textContent='';$('#stopDialog').showModal();};
}
document.addEventListener('click',async e=>{const close=e.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();const open=e.target.closest('[data-open]');if(open)openDetail(open.dataset.open);const trans=e.target.closest('[data-transition]');if(trans){const target=trans.dataset.transition;if(target==='done'&&!confirm('Підтвердити виконання всього замовлення?'))return;if(target==='queued'&&!confirm('Проблему усунено, актуальні креслення перевірено?'))return;trans.disabled=true;try{detail=await post('/api/orders/'+detail.id,{action:'status',version:detail.version,status:target});renderDetail();toast('Статус оновлено');}catch(err){toast(err.message);trans.disabled=false;}}});
$('#stopForm').elements.reason.onchange=e=>{$('#stopForm').elements.stopComment.required=e.target.value==='Інше';};
$('#stopForm').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await saveOrderStatus(stopping,'paused',{...Object.fromEntries(new FormData(e.target)),photos:await encodeStopPhotos()});$('#stopDialog').close();toast('Замовлення призупинено');}catch(err){$('#stopError').textContent=err.message;}finally{e.submitter.disabled=false;}};

function colorPriorityFields(){document.querySelectorAll('select[name="priority"]').forEach(select=>{select.classList.remove('priority-urgent','priority-high','priority-normal');select.classList.add('colored-select','priority-'+select.value);[...select.options].forEach(option=>option.className='priority-'+option.value);});}
document.addEventListener('change',e=>{if(e.target.matches('select[name="priority"]'))colorPriorityFields();});
function orderPrioritySelect(g){if(!ownsOrder(g.parts))return `<span class="badge priority-${g.priority}">${esc(priorities[g.priority])}</span>`;return `<select class="colored-select priority-${g.priority}" data-order-priority="${g.id}" aria-label="Пріоритет замовлення ${esc(g.number)}">${Object.entries(priorities).map(([key,label])=>`<option class="priority-${key}" value="${key}" ${g.priority===key?'selected':''}>${label}</option>`).join('')}</select>`;}
document.addEventListener('change',async e=>{
 const select=e.target.closest('[data-order-priority]');if(!select)return;
 const snapshot=orderSnapshot(select.dataset.orderPriority);select.disabled=true;
 try{const response=await fetch('/api/order-priority',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...snapshot,priority:select.value,actor:profile.name,role:profile.role,token:profile.token})});const result=await response.json();if(!response.ok)throw Error(result.error||'Не вдалося змінити пріоритет.');for(const o of result.orders){const i=orders.findIndex(x=>x.id===o.id);if(i>=0)orders[i]=o;}render();toast('Пріоритет замовлення змінено');}catch(err){toast(err.message);render();}
});
function orderWorkSeconds(g){
 return g.parts.reduce((max,o)=>Math.max(max,(Number(o.workSeconds)||0)+(o.status==='working'&&o.workStartedAt?Math.max(0,(Date.now()-Date.parse(o.workStartedAt))/1000)||0:0)),0);
}
$('#bendingActualTime').insertAdjacentHTML('afterend','<div id="activeTimeDeviation"></div>');
function renderActualBendingTime(groups){
 const seconds=Math.floor(groups.filter(g=>g.status!=='done').reduce((sum,g)=>sum+orderWorkSeconds(g),0));
 $('#bendingActualTime').textContent=`${Math.floor(seconds/3600)} год ${Math.floor(seconds/60)%60} хв`;
 const active=groups.filter(g=>g.status!=='done');let cents=0,missing=false;
 for(const g of active){const raw=g.parts.find(o=>o.bendingCost!==undefined&&o.bendingCost!==null&&o.bendingCost!=='')?.bendingCost;const cost=Number(raw);if(raw===undefined||!Number.isFinite(cost)||cost<0)missing=true;else cents+=Math.round(cost*100);}
 const delta=Math.floor(seconds/60)-Math.round(cents/100/1500*60);
 $('#activeTimeDeviation').innerHTML=missing?'<span class="time-deviation time-match">Порівняння неповне: є замовлення без вартості.</span>':delta>0?`<span class="time-deviation time-over">⚠ Перевищено орієнтовний час на ${Math.floor(delta/60)} год ${delta%60} хв</span>`:'';

}
function workTimer(g){
 if(g.status==='internal')return '<span class="sub">Без таймера</span>';
 const tracked=g.parts.filter(o=>o.workSeconds!==undefined||o.workStartedAt);
 if(!tracked.length)return '<span class="sub">Час гнуття: ще не зафіксовано</span>';
 const seconds=Math.max(...tracked.map(o=>(o.workSeconds||0)+(o.workStartedAt?Math.max(0,(Date.now()-Date.parse(o.workStartedAt))/1000):0)));
 const total=Math.floor(seconds), time=`${Math.floor(total/3600)} год ${Math.floor(total/60)%60} хв`;
 const started=tracked.find(o=>o.workStartedAt)?.workStartedAt;
 return `<span class="sub work-timer" data-work-timer="${g.id}">${g.status==='done'?'Час гнуття разом':'Час гнуття'}: <b>${time}</b>${started?`<span class="sub">Початок: ${fmt(started)}</span>`:''}${timeDeviation(g,seconds)}</span>`;
}
setInterval(()=>{const groups=groupedOrders();renderActualBendingTime(groups);renderCompletedBendingTotals(groups);document.querySelectorAll('[data-work-timer]').forEach(el=>{const g=groups.find(g=>g.id===el.dataset.workTimer);if(g)el.outerHTML=workTimer(g);});},1000);
function orderStatusSelect(g,showTimer=true){if(!canChangeStatus(g.parts))return `<span class="badge status-${g.status}">${esc(statuses[g.status])}</span>${showTimer?workTimer(g):''}`;return `<select class="order-status-select colored-select status-${g.status}" data-order-status="${g.id}" aria-label="Статус замовлення ${esc(g.number)}">${Object.entries(statuses).map(([key,label])=>`<option class="status-${key}" value="${key}" ${g.status===key?'selected':''}>${label}</option>`).join('')}</select>${showTimer?workTimer(g):''}`;}
function orderSnapshot(id){const g=groupedOrders().find(g=>g.parts.some(o=>o.id===id));return {id:g.id,versions:Object.fromEntries(g.parts.map(o=>[o.id,o.version]))};}
async function saveOrderStatus(snapshot,status,extra={}){
 const previousPhotos=new Set(orders.flatMap(o=>o.stopPhotos||[]).map(p=>p.id));
 const response=await fetch('/api/order-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...snapshot,status,...extra,actor:profile.name,role:profile.role,token:profile.token})});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Не вдалося змінити статус.');
 for(const o of result.orders){const i=orders.findIndex(x=>x.id===o.id);if(i>=0)orders[i]=o;}
 render();
 if(extra.photos?.length&&new Set(result.orders.flatMap(o=>o.stopPhotos||[]).filter(p=>!previousPhotos.has(p.id)).map(p=>p.id)).size<extra.photos.length)throw Error('Сервер не зберіг фото. Оновіть server.py і перезапустіть сервер. Вибрані фото залишено у формі.');
}
document.addEventListener('change',async e=>{
 const select=e.target.closest('[data-order-status]');if(!select)return;
 const snapshot=orderSnapshot(select.dataset.orderStatus),target=select.value;
 if(target==='done'&&profile.role==='operator'){finishing=snapshot;$('#finishForm').reset();$('#finishError').textContent='';$('#finishDialog').showModal();render();return;}
 if(target==='paused'){stopping=snapshot;$('#stopForm').reset();$('#stopForm').elements.stopComment.required=false;$('#stopError').textContent='';$('#stopDialog').showModal();render();return;}
 select.disabled=true;try{await saveOrderStatus(snapshot,target);toast('Статус усього замовлення оновлено');}catch(err){toast(err.message);render();}
});

let finishing=null;
document.body.insertAdjacentHTML('beforeend',`<dialog id="finishDialog"><form id="finishForm"><h2>Хто завершує роботу?</h2><label>Оператор<select name="completedBy" required><option value="">Оберіть оператора</option><option>Юра Курочкін</option><option>Андрій Сніданко</option></select></label><p id="finishError" class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary" data-close="finishDialog">Скасувати</button><button type="submit" class="primary">Підтвердити виконання</button></div></form></dialog>`);
$('#finishForm').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await saveOrderStatus(finishing,'done',{completedBy:e.target.elements.completedBy.value});$('#finishDialog').close();toast('Замовлення виконано');}catch(err){$('#finishError').textContent=err.message;}finally{e.submitter.disabled=false;}};
function deadlineControls(first){const g=groupedOrders().find(g=>g.parts.some(o=>o.id===first.id));return ownsOrder(g.parts)?`<form id="deadlineForm" class="deadline-form"><label>Бажана готовність<input name="due" type="date" value="${g.due}"></label><button class="secondary" type="submit">Зберегти дедлайн</button><span id="deadlineMessage" role="status"></span></form>`:`<p class="muted">Бажана готовність: ${day(g.due)}</p>`;}
document.addEventListener('submit',async e=>{if(e.target.id!=='deadlineForm')return;e.preventDefault();const button=e.submitter;button.disabled=true;try{const response=await fetch('/api/order-deadline',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...orderSnapshot(groupDetailId),due:e.target.elements.due.value,actor:profile.name,role:profile.role,token:profile.token})});const result=await response.json();if(!response.ok)throw Error(result.error);for(const o of result.orders){const i=orders.findIndex(x=>x.id===o.id);orders[i]=o;}render();toast('Дедлайн збережено');}catch(err){$('#deadlineMessage').textContent=err.message;}finally{button.disabled=false;}});
const hoverPreview=document.createElement('div');hoverPreview.className='drawing-preview';hoverPreview.hidden=true;hoverPreview.setAttribute('popover','manual');document.body.append(hoverPreview);
let previewTimer;
function closePreview(){clearTimeout(previewTimer);hoverPreview.hidePopover();hoverPreview.hidden=true;}
document.addEventListener('pointerover',e=>{const button=e.target.closest('.order-link[data-preview]');if(!button)return;clearTimeout(previewTimer);previewTimer=setTimeout(()=>{const o=orders.find(o=>o.id===button.dataset.preview);if(!o?.files.length||!o.files[0].name.toLowerCase().endsWith('.pdf'))return;hoverPreview.innerHTML=`<strong>${esc(o.title)}</strong><p>Завантаження креслення…</p><img alt="Передперегляд креслення"><small>Натисніть назву, щоб відкрити PDF.</small>`;const img=hoverPreview.querySelector('img');img.onload=()=>hoverPreview.querySelector('p').hidden=true;img.onerror=()=>{img.hidden=true;hoverPreview.querySelector('p').textContent='Передперегляд недоступний. Натисніть назву, щоб відкрити PDF.';};img.src='/preview/'+o.files[0].id;const rect=button.getBoundingClientRect();hoverPreview.style.left=Math.max(8,Math.min(rect.right+16,window.innerWidth-540))+'px';hoverPreview.style.top=Math.max(8,Math.min(rect.top,window.innerHeight-440))+'px';hoverPreview.hidden=false;hoverPreview.showPopover();},350);});
document.addEventListener('pointerout',e=>{if(e.target.closest('.order-link[data-preview]'))closePreview();});
document.addEventListener('click',closePreview);document.addEventListener('scroll',closePreview,true);
applyProfile();refresh();setInterval(refresh,5000);if(!profile)showProfile();

let stopPhotos=[];
$('#stopForm').elements.stopComment.parentElement.insertAdjacentHTML('afterend',`<div class="stop-photo-controls"><label>Фото проблеми<input id="stopPhotoFiles" type="file" accept="image/*" multiple></label><div id="stopPhotoDrafts" class="stop-photo-gallery"></div></div>`);
function clearStopPhotos(){stopPhotos.forEach(p=>URL.revokeObjectURL(p.url));stopPhotos=[];$('#stopPhotoDrafts').innerHTML='';}
$('#stopForm').addEventListener('reset',clearStopPhotos);
$('#stopDialog').addEventListener('close',clearStopPhotos);
function renderStopPhotos(){$('#stopPhotoDrafts').innerHTML=stopPhotos.map((p,i)=>`<div><img src="${p.url}" alt="${esc(p.file.name)}"><button type="button" class="secondary small-btn" data-remove-stop-photo="${i}">Прибрати</button></div>`).join('');}
for(const id of ['stopPhotoFiles'])$('#'+id).onchange=e=>{for(const file of e.target.files)stopPhotos.push({file,url:URL.createObjectURL(file)});renderStopPhotos();e.target.value='';};
$('#stopPhotoDrafts').onclick=e=>{const b=e.target.closest('[data-remove-stop-photo]');if(!b)return;const [removed]=stopPhotos.splice(Number(b.dataset.removeStopPhoto),1);URL.revokeObjectURL(removed.url);renderStopPhotos();};
async function encodeStopPhotos(){return Promise.all(stopPhotos.map(({file})=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:reader.result.split(',')[1]});reader.onerror=()=>reject(Error('Не вдалося прочитати фото'));reader.readAsDataURL(file);})))}
function stopPhotoGallery(parts){const add=canChangeStatus(parts)&&parts.some(o=>o.status==='paused')?`<button type="button" class="secondary small-btn" data-add-stop-photos="${parts[0].id}">Додати фото проблеми</button>`:'';const photos=[...new Map(parts.flatMap(o=>o.stopPhotos||[]).map(p=>[p.id,p])).values()];return photos.length?`<div class="section-title">Фото причин зупинки</div>${add}<div class="stop-photo-gallery">${photos.map(p=>`<a href="/photos/${p.id}" target="_blank" rel="noopener"><img loading="lazy" src="/photos/${p.id}" alt="${esc(p.name)}"><span>${esc(p.reason)}</span><small>${fmt(p.at)}</small></a>`).join('')}</div>`:`<div class="section-title">Фото причин зупинки</div><p class="muted">Фото ще не додано.</p>${add}`;}

document.addEventListener('click',e=>{const b=e.target.closest('[data-add-stop-photos]');if(!b)return;const o=orders.find(o=>o.id===b.dataset.addStopPhotos);stopping=orderSnapshot(o.id);$('#stopForm').reset();$('#stopForm').elements.reason.value=o.reason||'';$('#stopForm').elements.stopComment.value=o.stopComment||'';$('#stopForm').elements.stopComment.required=o.reason==='Інше';$('#stopError').textContent='';$('#stopDialog').showModal();});

// Scroll the page without changing focused numeric production fields.
document.addEventListener('wheel',e=>{
 const input=document.activeElement;
 if(input?.matches('input[type="number"][name="quantity"],input[type="number"][name="thickness"],input[type="number"][data-field="quantity"],input[type="number"][data-field="thickness"]'))input.blur();
},{capture:true,passive:true});

function compareOrders(a,b){
 const internal=Number(b.status==='internal')-Number(a.status==='internal');if(internal)return internal;
 const value=g=>({position:g.parts[0].queuePosition??null,number:g.number,count:g.parts.length,priority:rank[g.priority],due:g.due||null,status:{internal:-1,queued:0,working:1,paused:2,done:3}[g.status],manager:g.parts[0].manager})[sortColumn];
 if(sortColumn){const x=value(a),y=value(b);if(x==null||y==null)return x==null?(y==null?0:1):-1;const cmp=typeof x==='number'?x-y:String(x).localeCompare(String(y),'uk',{numeric:true});return sortDirection*cmp||a.created.localeCompare(b.created);}
 if(archive)return (b.completed||'').localeCompare(a.completed||'');
 return (a.parts[0].queuePosition??Infinity)-(b.parts[0].queuePosition??Infinity)||rank[a.priority]-rank[b.priority]||a.created.localeCompare(b.created);
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-sort]');if(!b)return;sortDirection=sortColumn===b.dataset.sort?-sortDirection:1;sortColumn=b.dataset.sort;render();});
document.addEventListener('change',async e=>{const input=e.target.closest('[data-position]');if(!input)return;if(!input.checkValidity()){input.reportValidity();return;}input.disabled=true;try{const r=await fetch('/api/order-position',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...orderSnapshot(input.dataset.position),position:input.value,actor:profile.name,role:profile.role,token:profile.token})});const data=await r.json();if(!r.ok)throw Error(data.error);for(const o of data.orders){orders[orders.findIndex(x=>x.id===o.id)]=o;}sortColumn=null;render();}catch(err){toast(err.message);input.disabled=false;}});

document.addEventListener('change',async e=>{const input=e.target.closest('[data-transfer]');if(!input)return;input.disabled=true;try{const response=await fetch('/api/order-welding',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...orderSnapshot(input.dataset.transfer),sendToWelding:input.checked,actor:profile.name,role:profile.role,token:profile.token})});const data=await response.json();if(!response.ok)throw Error(data.error);for(const o of data.orders)orders[orders.findIndex(x=>x.id===o.id)]=o;render();toast('Передачу на зварювання оновлено');}catch(err){input.checked=!input.checked;toast(err.message);}finally{input.disabled=false;}});

function costControls(first,parts){const cost=first.bendingCost??'';return ownsOrder(parts)?`<form id="costForm" class="deadline-form"><label>Вартість гнуття замовлення, грн<input name="bendingCost" type="number" min="0" step="0.01" value="${esc(cost)}" placeholder="Не вказано"></label><button type="submit" class="secondary">Зберегти вартість</button><span id="costMessage" role="status"></span></form>`:`<p>Вартість гнуття замовлення: <b>${cost!==''?esc(cost)+' грн':'Не вказано'}</b></p>`;}
document.addEventListener('submit',async e=>{if(e.target.id!=='costForm')return;e.preventDefault();const button=e.submitter;button.disabled=true;try{const response=await fetch('/api/order-cost',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...orderSnapshot(groupDetailId),bendingCost:e.target.elements.bendingCost.value,actor:profile.name,role:profile.role,token:profile.token})});const result=await response.json();if(!response.ok)throw Error(result.error);for(const o of result.orders)orders[orders.findIndex(x=>x.id===o.id)]=o;render();if($('#orderExpectedTime'))$('#orderExpectedTime').textContent=orderExpectedTime(result.orders[0]);toast('Вартість збережено');}catch(err){$('#costMessage').textContent=err.message;}finally{button.disabled=false;}});

function orderExpectedTime(order){const raw=order.bendingCost;if(raw===undefined||raw===null||raw==='')return 'Вкажіть вартість замовлення';const cost=Number(raw);if(!Number.isFinite(cost)||cost<0)return 'Вкажіть коректну вартість';const minutes=Math.round(cost/1500*60);return `${Math.floor(minutes/60)} год ${minutes%60} хв`;}

function timeDeviation(g,seconds){
 const raw=g.parts.find(o=>o.bendingCost!==undefined&&o.bendingCost!==null&&o.bendingCost!=='')?.bendingCost;
 if(raw===undefined||!Number.isFinite(Number(raw))||Number(raw)<0)return '<span class="sub">Для порівняння вкажіть вартість.</span>';
 const expected=Math.round(Number(raw)/1500*60),actual=Math.round(seconds/60),delta=actual-expected;
 const duration=n=>`${Math.floor(n/60)} год ${n%60} хв`;
 if(delta>0)return `<span class="time-deviation time-over">⚠ ${g.status==='done'?'Довше розрахунку':'Перевищено розрахунковий час'} на ${duration(delta)}</span>`;
 if(g.status==='done'&&delta<0)return `<span class="time-deviation time-under">Швидше розрахунку на ${duration(-delta)}</span>`;
 if(g.status==='done')return '<span class="time-deviation time-match">За розрахунковим часом (до хвилини)</span>';
 return '';
}

document.addEventListener('click',async e=>{const b=e.target.closest('[data-delete-order]');if(!b)return;const o=orders.find(o=>o.id===b.dataset.deleteOrder);const snapshot=orderSnapshot(o.id);if(!confirm(`Видалити замовлення «${o.number}» з усіма його деталями зі списку?`))return;b.disabled=true;try{const r=await fetch('/api/order-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...snapshot,actor:profile.name,role:profile.role,token:profile.token})});const result=await r.json();if(!r.ok)throw Error(result.error);orders=orders.filter(o=>!result.deleted.includes(o.id));$('#groupDialog').close();groupDetailId=null;render();toast('Замовлення видалено');}catch(err){toast(err.message);}finally{b.disabled=false;}});

// Close order windows only when the entire click is on their backdrop.
const backdropOrderDialogs=new Set(['importDialog','groupDialog','detailDialog','editDialog','wDialog']);
let backdropPress=null;
function orderBackdropTarget(e){
  const d=e.target;
  if(!(d instanceof HTMLDialogElement)||!d.open||!backdropOrderDialogs.has(d.id))return null;
  const r=d.getBoundingClientRect();
  return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom?d:null;
}
document.addEventListener('pointerdown',e=>{backdropPress=e.button===0?orderBackdropTarget(e):null;});
document.addEventListener('pointercancel',()=>{backdropPress=null;});
document.addEventListener('click',e=>{
  const d=orderBackdropTarget(e),pressed=backdropPress;backdropPress=null;
  if(!d||d!==pressed||d.querySelector('button[type="submit"]:disabled,[data-close]:disabled'))return;
  if(d.dispatchEvent(new Event('cancel',{cancelable:true})))d.close();
});

function orderStopComments(parts){
 const reasons=new Map();
 for(const o of parts){
  if(o.status!=='paused')continue;
  const reason=String(o.reason||'').trim(),comment=String(o.stopComment||'').trim();
  if(!reason&&!comment)continue;
  reasons.set(JSON.stringify([reason,comment]),{reason,comment});
 }
 return [...reasons.values()].map(({reason,comment})=>`<div class="callout"><b>Причина зупинки: ${esc(reason||'Не вказана')}</b>${comment?`<div class="prewrap">${esc(comment)}</div>`:''}</div>`).join('');
}

function partTypeLabel(count){const n=count%100,last=count%10;return n>=11&&n<=14?'типів':last===1?'тип':last>=2&&last<=4?'типи':'типів';}
