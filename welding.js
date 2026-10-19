'use strict';
const weldingStatuses={...statuses,review:'До перевірки'};
const bendingSection=document.querySelector('main>.content');
$('#archiveNav').insertAdjacentHTML('afterend','<button class="nav" id="weldingNav">⚒ <span>Зварювання</span><b id="wNavCount">0</b></button><button class="nav" id="weldingArchiveNav">✓ <span>Зварювання · виконані</span></button>');
$('#queueNav span').textContent='Гнуття';$('#archiveNav span').textContent='Гнуття · виконані';
document.querySelector('.brand>span:last-child').textContent='ВИРОБНИЦТВО';
document.querySelector('main').insertAdjacentHTML('beforeend',`<section class="content" id="weldingSection" hidden><div class="page-heading"><div><div class="eyebrow">КОНТРОЛЬ ВИРОБНИЦТВА</div><h1 id="wPageTitle">Черга зварювання</h1><p class="muted">Замовлення, креслення та призначення зварювальників.</p></div><button class="primary" id="wNew">＋ Додати замовлення</button></div><div class="queue-card"><div class="filters"><input id="wSearch" placeholder="Пошук за замовником, менеджером, зварювальником"><select id="wFilter"><option value="active">Усі активні</option><option value="internal">Внутрішнє</option><option value="queued">У черзі</option><option value="working">У роботі</option><option value="paused">Призупинено</option><option value="review">До перевірки</option><option value="done">Виконані</option></select><button class="secondary" id="wRefresh">Оновити</button></div><p id="wError" class="form-error" role="alert"></p><div class="table-wrap"><table><thead><tr><th id="wPositionHeading">№ ЧЕРГИ</th><th>ЗАМОВНИК</th><th>ПРІОРИТЕТ</th><th>ЗВАРЮВАЛЬНИКИ</th><th>ВАРТІСТЬ, ГРН</th><th>БАЖАНА ДАТА ГОТОВНОСТІ</th><th>СТАТУС</th><th>МЕНЕДЖЕР / ВНЕСЕНО</th><th>ЗАВЕРШЕНО</th></tr></thead><tbody id="wRows"></tbody></table></div><p id="wEmpty" class="muted">Замовлень немає.</p></div></section>`);
const wStats=bendingSection.querySelector('.stats').cloneNode(true);for(const node of wStats.querySelectorAll('[id]'))node.id='w'+node.id;$('#weldingSection .page-heading').after(wStats);
document.body.insertAdjacentHTML('beforeend',`<dialog id="wDialog" class="wide"><form id="wForm"><div class="dialog-heading"><h2 id="wTitle">Замовлення на зварювання</h2><button type="button" class="icon-btn" data-close="wDialog">×</button></div><div class="form-grid"><label>Замовник *<input name="customer" required maxlength="200"></label><label>Пріоритет<select name="priority"><option value="normal">Звичайний</option><option value="high">Підвищений</option><option value="urgent">Терміновий</option></select></label><label>Вартість зварювальних робіт, грн<input name="cost" type="number" min="0" step="0.01"></label><label>Бажана дата готовності<input name="due" type="date"></label><label class="transfer-choice"><input type="checkbox" name="sendToPainting">Після зварювання передати на фарбування</label><label>Коментар<textarea name="comment" maxlength="4000" rows="3"></textarea></label></div><div class="section-title">Креслення</div><div id="wFiles" class="file-list"></div><label id="wUploadLabel">Додати PDF (можна пізніше)<input id="wUpload" type="file" accept=".pdf,application/pdf" multiple></label><p id="wFormError" class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary" data-close="wDialog">Закрити</button><button type="button" id="wDelete" class="danger" hidden>Видалити замовлення</button><button id="wSave" type="submit" class="primary">Зберегти</button></div></form></dialog><dialog id="wPause"><form id="wPauseForm"><h2>Причина зупинки</h2><label>Причина<select name="reason" required>${$('#stopForm').elements.reason.innerHTML}</select></label><p id="wPauseError" class="form-error"></p><div class="dialog-actions"><button type="button" class="secondary" data-close="wPause">Скасувати</button><button type="submit" class="danger">Призупинити</button></div></form></dialog>`);
let weldingOrders=[],welders=[],wCurrent=null,wRequestId='',wPaused=null,wLoading=false,wGeneration=0;
const wCanEdit=o=>['chief','admin'].includes(profile?.role)||(profile?.role==='manager'&&o.manager===profile.name);
async function wApi(action,data={}){
 const response=await fetch('/api/welding/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,actor:profile?.name,role:profile?.role,token:profile?.token})});const result=await response.json();if(!response.ok)throw Error(result.error||'Не вдалося виконати дію.');return result;
}
function showDepartment(welding){
 if(welding&&!['manager','chief','admin'].includes(profile?.role))return;
 bendingSection.hidden=welding;$('#weldingSection').hidden=!welding;$('#weldingNav').classList.toggle('active',welding&&$('#wFilter').value!=='done');$('#weldingArchiveNav').classList.toggle('active',welding&&$('#wFilter').value==='done');$('#queueNav').classList.toggle('active',!welding&&!archive);$('#archiveNav').classList.toggle('active',!welding&&archive);
 document.querySelector('.breadcrumb').innerHTML='Виробництво <span>/</span> '+(welding?'Дільниця зварювання':'Дільниця гнуття');if(welding)wRefresh();
}
function weldingProfile(){wGeneration++;weldingOrders=[];welders=[];wLoading=false;$('#wDialog').close();$('#wPause').close();const allowed=['manager','chief','admin'].includes(profile?.role);$('#weldingNav').hidden=!allowed;$('#weldingArchiveNav').hidden=!allowed;$('#wNew').hidden=!['manager','chief','admin'].includes(profile?.role);$('#queueNav').hidden=profile?.role==='chief';$('#archiveNav').hidden=profile?.role==='chief';$('#newBtn').hidden=!['manager','admin'].includes(profile?.role);wRender();showDepartment(profile?.role==='chief'||(allowed&&!$('#weldingSection').hidden));}
window.addEventListener('profile-changed',weldingProfile);
$('#weldingNav').onclick=()=>{ $('#wFilter').value='active';$('#wSearch').value='';showDepartment(true);wRender();};
$('#weldingArchiveNav').onclick=()=>{ $('#wFilter').value='done';$('#wSearch').value='';showDepartment(true);wRender();};
$('#queueNav').addEventListener('click',()=>showDepartment(false));$('#archiveNav').addEventListener('click',()=>showDepartment(false));
async function wRefresh(){if(wLoading||!['manager','chief','admin'].includes(profile?.role))return;wLoading=true;const generation=wGeneration;try{const data=await wApi('list');if(generation!==wGeneration)return;weldingOrders=data.orders;welders=data.welders;$('#wError').textContent='';if(!document.activeElement?.closest('#wRows select, #wRows [data-w-position]'))wRender();}catch(err){if(generation===wGeneration)$('#wError').textContent=err.message;}finally{if(generation===wGeneration)wLoading=false;}}
function wCompletedStats(items,now=Date.now()){
 const today=kyivDateKey(now),month=today.slice(0,7),totals={Today:{count:0,cents:0,minutes:0,missingCost:0,missingHours:0},Month:{count:0,cents:0,minutes:0,missingCost:0,missingHours:0}};
 for(const o of items){
  if(o.status!=='done'||!o.completed)continue;const date=kyivDateKey(o.completed);if(!date||date>today||date.slice(0,7)!==month)continue;
  const cost=Number(o.cost),hasCost=o.cost!==undefined&&o.cost!==null&&o.cost!==''&&Number.isFinite(cost)&&cost>=0;
  const keys=['welding','support','logistics','other'];const hasHours=!!o.processHours&&keys.every(k=>Number.isFinite(Number(o.processHours[k]??0))&&Number(o.processHours[k]??0)>=0);
  const minutes=hasHours?keys.reduce((sum,k)=>sum+Number(o.processHours[k]||0)*60,0):0;
  for(const period of date===today?['Today','Month']:['Month']){const t=totals[period];t.count++;if(hasCost)t.cents+=Math.round(cost*100);else t.missingCost++;if(hasHours)t.minutes+=minutes;else t.missingHours++;}
 }
 return totals;
}
function wRenderCompletedStats(){
 let panel=$('#wCompletedTotals');
 if(!panel){$('#weldingSection .queue-card').insertAdjacentHTML('beforebegin',`<div id="wCompletedTotals" class="completed-bending-totals" hidden>${[['ExpectedToday','Очікуваний час сьогодні'],['ActualToday','Фактичний час сьогодні'],['ExpectedMonth','Очікуваний час місяць'],['ActualMonth','Фактичний час місяць']].map(([id,label])=>`<div class="stat"><span>${label}</span><strong id="w${id}"></strong><small id="w${id}Note"></small>${id.startsWith('Actual')?`<div id="w${id}Difference"></div>`:''}</div>`).join('')}</div>`);panel=$('#wCompletedTotals');}
 panel.hidden=$('#wFilter').value!=='done';if(panel.hidden)return;
 const totals=wCompletedStats(weldingOrders),duration=m=>`${Math.floor(m/60)} год ${m%60} хв`;
 for(const period of ['Today','Month']){const t=totals[period],expected=Math.round(t.cents/100/1200*60),actual=Math.round(t.minutes),delta=actual-expected;
 $('#wExpected'+period).textContent=duration(expected);$('#wActual'+period).textContent=duration(actual);
 $('#wExpected'+period+'Note').textContent=`Завершено замовлень: ${t.count}.`+(t.missingCost?` Без вартості: ${t.missingCost}.`:'');
 $('#wActual'+period+'Note').textContent=`Завершено замовлень: ${t.count}.`+(t.missingHours?` Без внесених годин: ${t.missingHours}.`:' Години за процесами.');
 $('#wActual'+period+'Difference').innerHTML=!t.count?'':t.missingCost||t.missingHours?'<span class="time-deviation time-match">Порівняння неповне: заповніть вартість і години всіх замовлень.</span>':delta>0?`<span class="time-deviation time-over">⚠ Довше розрахунку на ${duration(delta)}</span>`:delta<0?`<span class="time-deviation time-under">Швидше розрахунку на ${duration(-delta)}</span>`:'<span class="time-deviation time-match">За розрахунковим часом (до хвилини)</span>';
 }
}
function wRender(){
 wRenderActiveStats();
 wRenderCompletedStats();
 wRenderManagerCompleted();
 $('#wNavCount').textContent=weldingOrders.filter(o=>o.status!=='done').length;
 for(const [id,status] of [['wsQueued','queued'],['wsWorking','working'],['wsPaused','paused']])$('#'+id).textContent=weldingOrders.filter(o=>o.status===status).length;
 $('#wsDone').textContent=weldingOrders.filter(o=>o.status==='done').length;
 const done=$('#wFilter').value==='done',shown=!$('#weldingSection').hidden;
 $('#wPositionHeading').hidden=done;
 $('#wPageTitle').textContent=done?'Виконані замовлення · зварювання':'Черга зварювання';
 $('#weldingNav').classList.toggle('active',shown&&!done);$('#weldingArchiveNav').classList.toggle('active',shown&&done);
 $('#wEmpty').textContent=done?'Виконаних замовлень не знайдено.':'Замовлень не знайдено.';

 const q=$('#wSearch').value.toLocaleLowerCase('uk'),filter=$('#wFilter').value;
 const rows=weldingOrders.filter(o=>(filter==='active'?o.status!=='done':o.status===filter)&&[o.customer,o.manager,assignedNames(o).join(' ')].join(' ').toLocaleLowerCase('uk').includes(q)).sort((a,b)=>(Number(b.status==='internal')-Number(a.status==='internal'))||(filter==='done'?(b.completed||'').localeCompare(a.completed||''):((a.queuePosition??Infinity)-(b.queuePosition??Infinity)||0)||rank[a.priority||'normal']-rank[b.priority||'normal']||(a.due||'9999').localeCompare(b.due||'9999')||a.created.localeCompare(b.created)));
 $('#wRows').innerHTML=rows.map(o=>`<tr>${done?'':`<td>${['manager','chief','admin'].includes(profile?.role)?`<input class="queue-position" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="Номер черги зварювання" data-w-position="${o.id}" value="${o.queuePosition??''}">`:esc(o.queuePosition??'—')}</td>`}<td><button class="order-link" data-w-open="${o.id}">${esc(o.customer)}</button>${o.source?`<span class="sub">${esc(o.source)}</span>`:''}<span class="sub">PDF: ${o.files.length}</span></td><td>${wPriority(o)}</td><td>${assignedNames(o).map(esc).join('<br>')||'Не призначено'}</td><td>${esc(o.cost||'—')}</td><td>${day(o.due)}</td><td>${wCanEdit(o)?`<select class="colored-select status-${o.status}" data-w-status="${o.id}">${Object.entries(weldingStatuses).map(([k,v])=>`<option value="${k}" ${o.status===k?'selected':''}>${v}</option>`).join('')}</select>`:`<span class="badge status-${o.status}">${weldingStatuses[o.status]}</span>`}${o.reason?`<span class="sub">${esc(o.reason)}</span>`:''}</td><td>${esc(o.manager)}<span class="sub">${fmt(o.created)}</span></td><td>${o.completed?esc(o.completedBy)+`<span class="sub">${fmt(o.completed)}</span>`:'—'}</td></tr>`).join('');$('#wEmpty').hidden=!!rows.length;
}
function wOpen(o=null){wCurrent=o?structuredClone(o):null;wRequestId=importId();$('#wForm').reset();$('#wFormError').textContent='';const editable=o?wCanEdit(o):['manager','chief','admin'].includes(profile?.role);for(const name of ['customer','cost','due','comment']){const input=$('#wForm').elements[name];input.value=o?.[name]||'';input.readOnly=!editable;}$('#wForm').elements.priority.value=o?.priority||'normal';$('#wForm').elements.priority.disabled=!editable;colorPriorityFields();$('#wFiles').innerHTML=wFileButtons(o);$('#wUploadLabel').hidden=!editable;$('#wSave').hidden=!editable;$('#wTitle').textContent=o?'Замовлення на зварювання':'Додати замовлення на зварювання';$('#wDelete').hidden=!(o&&(['chief','admin'].includes(profile?.role)||profile?.role==='manager'&&o.manager===profile.name));$('#wForm').elements.sendToPainting.checked=!!o?.sendToPainting;$('#wForm').elements.sendToPainting.disabled=!editable;renderProcessHours(o);$('#wDialog').showModal();}
$('#wNew').onclick=()=>wOpen();$('#wRefresh').onclick=wRefresh;$('#wSearch').oninput=wRender;$('#wFilter').onchange=wRender;
document.addEventListener('click',async e=>{const open=e.target.closest('[data-w-open]');if(open)wOpen(weldingOrders.find(o=>o.id===open.dataset.wOpen));const file=e.target.closest('[data-w-file]');if(file){const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;try{const result=await wApi('file',{id:file.dataset.wFile});const bytes=Uint8Array.from(atob(result.data),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:result.name.toLowerCase().endsWith('.pdf')?'application/pdf':'application/dxf'}));if(tab&&result.name.toLowerCase().endsWith('.pdf'))tab.location.href=url;else{tab?.close();const a=document.createElement('a');a.href=url;a.download=result.name;a.click();}setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(err){tab?.close();toast(err.message);}}});
$('#wForm').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;$('#wFormError').textContent='';try{const files=[];for(const f of $('#wUpload').files){if(!f.name.toLowerCase().endsWith('.pdf'))throw Error('Оберіть PDF-креслення.');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(Error('Не вдалося прочитати PDF'));r.readAsDataURL(f);});files.push({name:f.name,data});}await wApi(wCurrent?'edit':'create',{...Object.fromEntries(new FormData(e.target)),sendToPainting:e.target.elements.sendToPainting.checked,files,id:wCurrent?.id,version:wCurrent?.version,requestId:wRequestId});$('#wDialog').close();await wRefresh();toast('Замовлення збережено');}catch(err){$('#wFormError').textContent=err.message;}finally{e.submitter.disabled=false;}};
document.addEventListener('change',async e=>{const input=e.target.closest('[data-w-status],[data-w-priority]');if(!input)return;const o=weldingOrders.find(o=>o.id===(input.dataset.wStatus||input.dataset.wPriority));if(input.dataset.wStatus&&input.value==='done'){openWorkerComplete(o);wRender();return;}if(input.dataset.wStatus&&['chief','admin'].includes(profile?.role)){if(input.value==='working'){openWorkerStart(o);wRender();return;}if(o.workerJobs?.length&&['paused','done'].includes(input.value)){openWorkerPickStop(o,input.value);wRender();return;}}if(input.dataset.wStatus&&input.value==='done'&&['chief','admin'].includes(profile?.role)){openWFinish(o);wRender();return;}if(input.dataset.wStatus&&input.value==='paused'){wPaused=structuredClone(o);$('#wPauseForm').reset();$('#wPauseError').textContent='';$('#wPause').showModal();wRender();return;}input.disabled=true;try{await wApi(input.dataset.wPriority?'priority':'status',{id:o.id,version:o.version,welder:input.value,status:input.value,priority:input.value});input.blur();await wRefresh();}catch(err){toast(err.message);input.blur();await wRefresh();}finally{input.disabled=false;}});
$('#wPauseForm').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await wApi('status',{id:wPaused.id,version:wPaused.version,status:'paused',reason:e.target.elements.reason.value});$('#wPause').close();await wRefresh();}catch(err){$('#wPauseError').textContent=err.message;}finally{e.submitter.disabled=false;}};
weldingProfile();setInterval(wRefresh,5000);

function wPriority(o){const p=o.priority||'normal';return wCanEdit(o)?`<select class="colored-select priority-${p}" data-w-priority="${o.id}" aria-label="Пріоритет замовлення">${Object.entries(priorities).map(([k,v])=>`<option value="${k}" class="priority-${k}" ${k===p?'selected':''}>${v}</option>`).join('')}</select>`:`<span class="badge priority-${p}">${priorities[p]}</span>`;}

function assignedNames(o){return Array.isArray(o.assignedWelders)?o.assignedWelders:(o.welder?[o.welder]:[]);}
$('#wDelete').onclick=async()=>{const o=structuredClone(wCurrent);if(!o||!confirm(`Видалити замовлення «${o.customer}» зі списку зварювання?`))return;const b=$('#wDelete');b.disabled=true;try{await wApi('delete',{id:o.id,version:o.version});weldingOrders=weldingOrders.filter(x=>x.id!==o.id);$('#wDialog').close();wRender();toast('Замовлення видалено');}catch(err){$('#wFormError').textContent=err.message;}finally{b.disabled=false;}};

let wPreviewTimer,wPreviewGeneration=0;
function closeWeldingPreview(){clearTimeout(wPreviewTimer);wPreviewGeneration++;closePreview();}
document.addEventListener('pointerover',e=>{
 const button=e.target.closest('[data-w-file]');if(!button||button.contains(e.relatedTarget)||button.textContent.toLowerCase().trim().endsWith('.dxf'))return;
 clearTimeout(wPreviewTimer);const generation=++wPreviewGeneration;
 wPreviewTimer=setTimeout(async()=>{
  hoverPreview.innerHTML=`<strong>${esc(button.textContent)}</strong><p>Завантаження креслення…</p><img hidden alt="Передперегляд креслення"><small>Натисніть назву, щоб відкрити PDF.</small>`;
  const rect=button.getBoundingClientRect();hoverPreview.style.left=Math.max(8,Math.min(rect.right+16,window.innerWidth-540))+'px';hoverPreview.style.top=Math.max(8,Math.min(rect.top,window.innerHeight-440))+'px';hoverPreview.hidden=false;hoverPreview.showPopover();
  try{const result=await wApi('preview',{id:button.dataset.wFile});if(generation!==wPreviewGeneration)return;const img=hoverPreview.querySelector('img');img.src='data:image/png;base64,'+result.data;img.hidden=false;hoverPreview.querySelector('p').hidden=true;}
  catch(err){if(generation===wPreviewGeneration)hoverPreview.querySelector('p').textContent=err.message==='Замовлення не знайдено.'?'Сервер ще не підтримує передперегляд. Замініть welding.py у папці запущеної програми та перезапустіть сервер через RESTART-SERVER.cmd.':err.message;}
 },350);
});
document.addEventListener('pointerout',e=>{const b=e.target.closest('[data-w-file]');if(b&&!b.contains(e.relatedTarget))closeWeldingPreview();});
$('#wDialog').addEventListener('close',closeWeldingPreview);
$('#wDialog').addEventListener('scroll',closeWeldingPreview);
window.addEventListener('profile-changed',closeWeldingPreview);

const processHourLabels={welding:'Зварювання',support:'Допоміжні операції',logistics:'Логістика',other:'Інше'};
$('#wFormError').insertAdjacentHTML('beforebegin','<section id="wProcessHours" hidden></section>');
function renderProcessHours(o){
 const section=$('#wProcessHours');section.hidden=o?.status!=='done'||!!o?.workerJobs?.length;if(section.hidden){section.innerHTML='';return;}
 const editable=['chief','admin'].includes(profile?.role)&&!o?.workerJobs?.length;
 section.innerHTML=`<div class="section-title">Фактичні години за процесами</div><p class="muted">Години десятковим числом: 1,5 = 1 год 30 хв.</p><div class="form-grid">${Object.entries(processHourLabels).map(([key,label])=>`<label>${label}, год<input data-process-hours="${key}" type="text" inputmode="decimal" value="${esc(o.processHours?.[key]??'')}" placeholder="0" ${editable?'':'readonly'}></label>`).join('')}<label>Коментар до «Інше»<textarea id="wHoursComment" maxlength="4000" rows="2" ${editable?'':'readonly'}>${esc(o.processHoursComment||'')}</textarea></label></div><p id="wHoursTotal"></p><p id="wHoursError" class="form-error" role="alert"></p>${editable?'<button type="button" id="wHoursSave" class="secondary">Зберегти години</button>':''}`;
 updateHoursTotal();
 section.oninput=updateHoursTotal;
 if(editable)$('#wHoursSave').onclick=async()=>{
  const button=$('#wHoursSave');button.disabled=true;$('#wHoursError').textContent='';
  try{const processHours=Object.fromEntries([...section.querySelectorAll('[data-process-hours]')].map(i=>[i.dataset.processHours,i.value]));const saved=await wApi('process-hours',{id:wCurrent.id,version:wCurrent.version,processHours,processHoursComment:$('#wHoursComment').value});wCurrent=structuredClone(saved);const i=weldingOrders.findIndex(o=>o.id===saved.id);if(i>=0)weldingOrders[i]=saved;renderProcessHours(saved);wRender();toast('Години збережено');}
  catch(err){$('#wHoursError').textContent=err.message;}finally{button.disabled=false;}
 };
}
function updateHoursTotal(){const values=[...document.querySelectorAll('[data-process-hours]')].map(i=>Number(i.value.trim().replace(',','.')));$('#wHoursTotal').textContent=values.every(n=>Number.isFinite(n)&&n>=0)?'Разом: '+values.reduce((a,b)=>a+b,0).toLocaleString('uk-UA',{maximumFractionDigits:2})+' год':'Перевірте введені години.';}

let wFinishing=null;
document.body.insertAdjacentHTML('beforeend',`<dialog id="wFinishDialog" class="wide"><form id="wFinishForm"><h2>Завершити замовлення · зварювання</h2><p>Вкажіть витрачений час у годинах: 1,5 = 1 год 30 хв. Для невиконаних процесів залиште 0.</p><div class="form-grid">${Object.entries(processHourLabels).map(([key,label])=>`<label>${label}, год<input name="${key}" type="text" inputmode="decimal" value="0" required></label>`).join('')}<label>Коментар до «Інше»<textarea name="hoursComment" maxlength="4000"></textarea></label></div><p id="wFinishError" class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary" data-close="wFinishDialog">Скасувати</button><button type="submit" class="primary">Зберегти та завершити</button></div></form></dialog>`);
function openWFinish(o){wFinishing=structuredClone(o);const f=$('#wFinishForm');f.reset();for(const key of Object.keys(processHourLabels))f.elements[key].value=o.processHours?.[key]??'0';f.elements.hoursComment.value=o.processHoursComment||'';$('#wFinishError').textContent='';$('#wFinishDialog').showModal();}
$('#wFinishForm').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const f=e.target;await wApi('process-hours',{id:wFinishing.id,version:wFinishing.version,complete:true,processHours:Object.fromEntries(Object.keys(processHourLabels).map(k=>[k,f.elements[k].value])),processHoursComment:f.elements.hoursComment.value});$('#wFinishDialog').close();await wRefresh();toast('Години збережено. Замовлення виконано');}catch(err){$('#wFinishError').textContent=err.message;}finally{b.disabled=false;}};
window.addEventListener('profile-changed',()=>$('#wFinishDialog').close());

function wActiveTotals(items){
 const t={count:0,cents:0,minutes:0,missingCost:0,missingHours:0};
 for(const o of items){if(!['internal','queued','working','paused','review'].includes(o.status))continue;t.count++;
 const cost=Number(o.cost);if(o.cost===undefined||o.cost===null||o.cost===''||!Number.isFinite(cost)||cost<0)t.missingCost++;else t.cents+=Math.round(cost*100);
 const keys=['welding','support','logistics','other'];if(!o.processHours||!keys.every(k=>Number.isFinite(Number(o.processHours[k]??0))&&Number(o.processHours[k]??0)>=0))t.missingHours++;else t.minutes+=keys.reduce((n,k)=>n+Number(o.processHours[k]||0)*60,0);
 t.minutes+=(o.workerJobs||[]).filter(j=>j.status==='working'&&j.startedAt).reduce((sum,j)=>sum+Math.max(0,(Date.now()-Date.parse(j.startedAt))/60000),0);
 }return t;
}
function wRenderActiveStats(){
 if(!$('#wActiveStats'))$('#weldingSection .queue-card').insertAdjacentHTML('beforebegin',`<section id="wActiveStats"><div class="bending-totals" id="wActiveTotals"><div class="stat" id="wActiveCostCard"><span>Загальна сума активних замовлень</span><strong id="wActiveCost"></strong><small id="wActiveCostNote"></small></div><div class="stat"><span>Очікуваний час зварювання</span><strong id="wActiveExpected"></strong><small>Оцінка за вартістю: сума ÷ 1 200 грн/год</small></div><div class="stat"><span>Фактичний час зварювання</span><strong id="wActiveActual"></strong><div id="wActiveDifference"></div><small id="wActiveActualNote"></small></div></div><section id="wActiveManagers" style="margin-bottom:24px"><h3>Очікуваний час за менеджерами · активні замовлення</h3><div class="manager-time-cards" id="wActiveManagerCards"></div></section></section>`);
 $('#wActiveStats').hidden=$('#wFilter').value==='done';if($('#wActiveStats').hidden)return;
 const admin=['chief','admin'].includes(profile?.role),t=wActiveTotals(weldingOrders),duration=m=>`${Math.floor(m/60)} год ${m%60} хв`,expected=Math.round(t.cents/100/1200*60),actual=Math.round(t.minutes);
 $('#wActiveCostCard').hidden=profile?.role!=='admin';$('#wActiveTotals').classList.toggle('operator-totals',profile?.role!=='admin');$('#wActiveManagers').hidden=!admin;
 $('#wActiveCost').textContent=(t.cents/100).toLocaleString('uk-UA',{maximumFractionDigits:2})+' грн';$('#wActiveCostNote').textContent=`Активних замовлень: ${t.count}. Без вартості: ${t.missingCost}.`;
 $('#wActiveExpected').textContent=duration(expected);$('#wActiveActual').textContent=t.count&&t.missingHours===t.count?'Ще не внесено':duration(actual);
 $('#wActiveActualNote').textContent=`Внесені години активних замовлень. Без годин: ${t.missingHours}.`;
 $('#wActiveDifference').innerHTML=t.missingCost||t.missingHours?'<span class="time-deviation time-match">Порівняння неповне: є замовлення без вартості або годин.</span>':actual>expected?`<span class="time-deviation time-over">⚠ Перевищено орієнтовний час на ${duration(actual-expected)}</span>`:'';
 if(admin){const names=[...new Set([...staff.manager,...weldingOrders.map(o=>o.manager).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'uk'));$('#wActiveManagerCards').innerHTML=names.map(name=>{const m=wActiveTotals(weldingOrders.filter(o=>o.manager===name));return `<article class="stat manager-time-card"><h4>${esc(name)}</h4><div class="manager-time-metric"><span>Очікуваний час активних замовлень</span><strong>${duration(Math.round(m.cents/100/1200*60))}</strong><small>Замовлень: ${m.count}${m.missingCost?` · Без вартості: ${m.missingCost}`:''}</small></div></article>`;}).join('');}
}

document.addEventListener('change',async e=>{const input=e.target.closest('[data-w-position]');if(!input)return;const o=weldingOrders.find(o=>o.id===input.dataset.wPosition);if(!o)return;input.disabled=true;try{const saved=await wApi('position',{id:o.id,version:o.version,position:input.value});const index=weldingOrders.findIndex(x=>x.id===saved.id);if(index>=0)weldingOrders[index]=saved;wRender();toast('Номер черги збережено');}catch(err){toast(err.message);await wRefresh();}finally{input.disabled=false;}});

function wRenderManagerCompleted(){
 if(!$('#wManagerCompleted'))$('#weldingSection .queue-card').insertAdjacentHTML('beforebegin','<section id="wManagerCompleted" style="margin-bottom:24px" hidden><h3>Час зварювання за менеджерами · виконані за місяць</h3><div class="manager-time-cards" id="wManagerCompletedCards"></div></section>');
 const allowed=['manager','chief','admin'].includes(profile?.role);$('#wManagerCompleted').hidden=!allowed||$('#wFilter').value!=='done';if($('#wManagerCompleted').hidden)return;
 const full=['chief','admin'].includes(profile?.role),duration=m=>`${Math.floor(m/60)} год ${m%60} хв`;
 const names=[...new Set([...staff.manager,...weldingOrders.map(o=>o.manager).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'uk'));
 $('#wManagerCompletedCards').innerHTML=names.map(name=>{const t=wCompletedStats(weldingOrders.filter(o=>o.manager===name)).Month;return `<article class="stat manager-time-card"><h4>${esc(name)}</h4><div class="manager-time-metric"><span>Очікуваний час місяць</span><strong>${duration(Math.round(t.cents/100/1200*60))}</strong><small>Замовлень: ${t.count}${t.missingCost?` · Без вартості: ${t.missingCost}`:''}</small></div>${full?`<div class="manager-time-metric"><span>Фактичний час місяць</span><strong>${duration(Math.round(t.minutes))}</strong><small>${t.missingHours?`Без внесених годин: ${t.missingHours}`:'Внесені години за процесами'}</small></div>`:''}</article>`;}).join('');
}

function wFileButtons(o){return (o?.files||[]).map(f=>`<span class="w-file-item"><button type="button" class="secondary small-btn" data-w-file="${f.id}">▧ ${esc(f.name)}</button>${wCanEdit(o)?`<button type="button" class="w-file-remove" data-w-remove-file="${f.id}" aria-label="Видалити креслення ${esc(f.name)}" title="Видалити креслення">×</button>`:''}</span>`).join('');}
document.addEventListener('click',async e=>{
 const b=e.target.closest('[data-w-remove-file]');if(!b||!wCurrent)return;
 const o=structuredClone(wCurrent),file=o.files.find(f=>f.id===b.dataset.wRemoveFile);if(!file)return;
 if(!confirm(`Видалити креслення «${file.name}» із замовлення?`))return;
 b.disabled=true;closeWeldingPreview();
 try{const saved=await wApi('remove-file',{id:o.id,version:o.version,fileId:file.id});const index=weldingOrders.findIndex(x=>x.id===saved.id);if(index>=0)weldingOrders[index]=saved;if(wCurrent?.id===saved.id){wCurrent=structuredClone(saved);$('#wFiles').innerHTML=wFileButtons(saved);}wRender();toast('Креслення видалено');}
 catch(err){$('#wFormError').textContent=err.message;}finally{b.disabled=false;}
});
