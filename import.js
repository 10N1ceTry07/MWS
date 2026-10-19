'use strict';
// Every uploaded document owns its own editable draft and exactly one queue entry.
document.body.insertAdjacentHTML('beforeend', `<dialog id="importDialog" class="wide"><form id="importForm">
<div class="dialog-heading"><div><div class="eyebrow">1 СТОРІНКА PDF = 1 ДЕТАЛЬ</div><h2>Додати замовлення на гнуття</h2></div><button type="button" class="icon-btn" data-close="importDialog" aria-label="Закрити">×</button></div>
<label class="upload">1. Завантажте PDF-креслення<input id="importFiles" type="file" accept=".pdf,application/pdf" multiple><small>Без фіксованих лімітів кількості й розміру. Файли обробляються по черзі, сторінки стають окремими деталями.</small></label>
<button type="button" class="secondary" id="addManualPart">＋ Додати деталь без PDF</button>
<p id="importStatus" class="muted" role="status">Назва — з назви файла. Товщина й кількість — із креслення або назви файла. Невизначені дані введіть вручну.</p>
<div id="importFields" hidden><div class="section-title">2. Дані замовлення для цих деталей</div><div class="form-grid"><label>Замовник *<input name="number" maxlength="80" required></label><label>Пріоритет<select name="priority"><option value="normal">Звичайний</option><option value="high">Підвищений</option><option value="urgent">Терміновий</option></select></label><label>Бажана дата готовності<input name="due" type="date"></label><label>Вартість гнуття замовлення, грн<input name="bendingCost" type="number" min="0" step="0.01" placeholder="Не вказано"></label><label class="transfer-choice"><input name="sendToWelding" type="checkbox">Після гнуття передати на зварювання</label><label class="transfer-choice"><input name="sendToPainting" type="checkbox">Після гнуття передати на фарбування</label><label>Коментар<input name="comment" maxlength="4000"></label></div><div class="section-title">3. Перевірте назву, товщину, матеріал і кількість</div><div id="importDrafts"></div></div>
<p id="importError" class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary" data-close="importDialog">Скасувати</button><button id="importSubmit" type="submit" class="primary" disabled>Додати замовлення в чергу</button></div></form></dialog>`);
let importDrafts=[],importGeneration=0,importTokens=[],importSaving=false,importGroupId='',importLoading=false;
// getRandomValues also works over HTTP on the trusted local network.
function importId(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');}
function discardTokens(tokens){if(tokens.length)fetch('/api/discard-staged',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tokens,actor:profile.name,role:profile.role,token:profile.token})}).catch(()=>{});}
function openImport(){
  importWeldingPreparation=null;
  importGroupId=importId();
  if(!profile){showProfile();return;}if(!['manager','admin'].includes(profile.role))return;
  importGeneration++;importLoading=false;importDrafts=[];$('#importForm').reset();colorPriorityFields();$('#importFields').hidden=true;$('#importDrafts').innerHTML='';$('#importError').textContent='';$('#importSubmit').disabled=true;$('#importFiles').disabled=false;
  $('#importStatus').textContent='Назва — з назви файла. Товщина й кількість — із креслення або назви файла. Невизначені дані введіть вручну.';$('#importDialog').showModal();
}
$('#newBtn').textContent='＋ Додати замовлення';$('#emptyAdd').textContent='＋ Додати замовлення';
$('#newBtn').onclick=openImport;$('#emptyAdd').onclick=openImport;
$('#importDialog').addEventListener('close',()=>{importGeneration++;discardTokens(importTokens);importTokens=[];});
$('#importDialog').addEventListener('cancel',e=>{if(importSaving)e.preventDefault();});
$('#importFiles').onchange=async()=>{
  const generation=++importGeneration,files=[...$('#importFiles').files];
  $('#importError').textContent='';
  if(!files.length)return;
  if(files.some(f=>!f.name.toLowerCase().endsWith('.pdf'))){$('#importError').textContent='Оберіть PDF-файли.';return;}
  const batchTokens=[];importLoading=true;$('#importFiles').disabled=true;$('#importSubmit').disabled=true;
  $('#importStatus').textContent=`Зчитуємо ${files.length} PDF та розділяємо сторінки на деталі…`;
  try{
    const result={files:[]};
    for(let index=0;index<files.length;index++){
      if(generation!==importGeneration)return;
      const file=files[index];$('#importStatus').textContent=`Читаємо файл ${index+1} із ${files.length}: ${file.name}`;
      const payload=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:reader.result.split(',')[1]});reader.onerror=()=>reject(Error('Не вдалося прочитати '+file.name));reader.readAsDataURL(file);});
      const response=await fetch('/api/extract-pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:[payload],splitPages:true,stage:true,actor:profile.name,role:profile.role,token:profile.token})});
      const data=await response.json();if(!response.ok)throw Error(data.error||'Не вдалося зчитати PDF.');
      if(data.files.some(f=>!f.token))throw Error('Сервер потребує оновлення. Перезапустіть програму й виберіть PDF повторно.');
      if(generation!==importGeneration){discardTokens(data.files.map(f=>f.token));return;}
      batchTokens.push(...data.files.map(f=>f.token));
      result.files.push(...data.files);
    }
    if(generation!==importGeneration)return;
    const offset=importDrafts.length;
    importDrafts.push(...result.files.map(file=>({name:file.name,token:file.token,requestId:importId()})));
    importTokens.push(...batchTokens);
    $('#importDrafts').insertAdjacentHTML('beforeend',result.files.map((file,j)=>{
      const i=offset+j;
      const title=file.name.replace(/\.pdf$/i,''),thickness=file.thicknesses.length===1?file.thicknesses[0]:'',material=file.materials?.length===1?file.materials[0]:'';
      const quantity=file.quantities?.length===1?file.quantities[0]:'';
      const source=field=>file[field+'Source']==='filename'?'з назви файла':'з креслення';
      const help=[];
      if(!quantity)help.push('Кількість не визначено однозначно — введіть вручну.');
      if(!title)help.push(file.titles.length>1?'Назви у PDF: '+file.titles.join('; ')+'. Вкажіть потрібну.':'Назву не знайдено — введіть вручну.');
      if(!thickness)help.push(file.thicknesses.length>1?'Товщини у PDF: '+file.thicknesses.join('; ')+'. Вкажіть потрібну.':'Товщину не знайдено — введіть вручну.');
      if(!material)help.push('Матеріал не визначено однозначно — введіть вручну.');if(file.message)help.push(file.message);
      return `<section class="import-part" data-draft="${i}"><div class="import-part-heading"><strong data-draft-heading>Деталь ${i+1} · ${esc(file.name)}</strong><button type="button" class="secondary small-btn" data-remove-draft aria-label="Видалити PDF ${esc(file.name)}">Видалити PDF</button></div><p class="muted">${help.length?esc(help.join(' ')):'Назва з файла; товщина й матеріал з креслення. Перевірте дані перед збереженням.'}</p><div class="form-grid"><label class="${title?'':'needs-value'}">Назва деталі · з назви файла *<input data-field="title" value="${esc(title)}" required maxlength="200" aria-describedby="titleHint${importDrafts[i].requestId}"><small id="titleHint${importDrafts[i].requestId}" class="missing-hint">Не зчитано однозначно — введіть назву вручну.</small></label><label class="${thickness?'':'needs-value'}">Товщина, мм ${thickness?'· '+source('thicknesses'):'· вручну'} *<input data-field="thickness" type="number" value="${thickness}" required min="0.01" max="500" step="0.01" aria-describedby="thicknessHint${importDrafts[i].requestId}"><small id="thicknessHint${importDrafts[i].requestId}" class="missing-hint">Не зчитано однозначно — введіть товщину вручну.</small></label><label class="${material?'':'needs-value'}">Матеріал ${material?'· з креслення':'· вручну'} *<input data-field="material" value="${esc(material)}" required maxlength="100" list="materials" placeholder="Оберіть або введіть"><small class="missing-hint">Матеріал не знайдено — введіть вручну.</small></label><label class="${quantity?'':'needs-value'}">Кількість, шт. ${quantity?'· '+source('quantities'):'· вручну'} *<input data-field="quantity" type="number" value="${quantity}" required min="1" max="10000000" step="1" placeholder="Введіть кількість"></label></div></section>`;
    }).join(''));
    $('#importFields').hidden=false;$('#importSubmit').disabled=false;$('#importStatus').textContent=`Підготовлено деталей: ${importDrafts.length}. Кожна сторінка матиме власний PDF і окремий рядок у черзі. Червоні поля потрібно заповнити вручну.`;
  }catch(err){discardTokens(batchTokens);if(generation===importGeneration){$('#importError').textContent=err.message;$('#importStatus').textContent='Не вдалося підготувати деталі. Виберіть PDF ще раз. Попередні деталі залишено.';}}
  finally{if(generation===importGeneration){importLoading=false;$('#importFiles').disabled=false;$('#importFiles').value='';$('#importSubmit').disabled=!importDrafts.length;}else discardTokens(batchTokens);}
};
$('#importDrafts').addEventListener('input',e=>{const input=e.target;if(['title','thickness','material','quantity'].includes(input.dataset.field))input.closest('label').classList.toggle('needs-value',!input.value.trim()||!input.validity.valid);});
$('#importDrafts').addEventListener('click',e=>{
 const button=e.target.closest('[data-remove-draft]');if(!button||importSaving||importLoading)return;
 const row=button.closest('[data-draft]'),index=Number(row.dataset.draft),draft=importDrafts[index];
 if(!draft||draft.saved)return;
 importDrafts.splice(index,1);row.remove();
 importTokens=importTokens.filter(token=>token!==draft.token);if(draft.token)discardTokens([draft.token]);
 document.querySelectorAll('#importDrafts [data-draft]').forEach((item,i)=>{item.dataset.draft=i;item.querySelector('[data-draft-heading]').textContent=`Деталь ${i+1} · ${importDrafts[i].name}`;});
 $('#importSubmit').disabled=!importDrafts.length;
 $('#importStatus').textContent=importDrafts.length?`Залишилося деталей: ${importDrafts.length}.`:'Усі PDF видалено зі списку. Виберіть файли повторно.';
 if(!importDrafts.length){$('#importFiles').value='';$('#importFields').hidden=true;}
 $('#importError').textContent='';
});
$('#importForm').onsubmit=async e=>{
  e.preventDefault();if(!importDrafts.length)return;
  const generation=importGeneration;$('#importSubmit').disabled=true;$('#importFiles').disabled=true;$('#importError').textContent='';
  importSaving=true;document.querySelectorAll('[data-remove-draft]').forEach(b=>b.disabled=true);document.querySelectorAll('[data-close="importDialog"]').forEach(b=>b.disabled=true);
  const common={...Object.fromEntries(new FormData(e.target)),groupId:importGroupId};
  const items=[...document.querySelectorAll('[data-draft]')].map((row,i)=>{const item={file:importDrafts[i],requestId:importDrafts[i].requestId};row.querySelectorAll('[data-field]').forEach(input=>item[input.dataset.field]=input.value);return item;});
  try{
    for(let i=0;i<items.length;i++){
      if(generation!==importGeneration)break;
      if(importDrafts[i].saved)continue;
      $('#importStatus').textContent=`Зберігаємо деталь ${i+1} із ${items.length}…`;
      const response=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...common,weldingPreparation:common.sendToWelding&&i===0?importWeldingPreparation:undefined,items:[items[i]],actor:profile.name,role:profile.role,token:profile.token})});
      const data=await response.json();if(!response.ok)throw Error(data.error||'Не вдалося зберегти деталі.');
      importDrafts[i].saved=true;document.querySelector(`[data-draft="${i}"]`).querySelectorAll('input').forEach(input=>input.readOnly=true);
    }
    await refresh();if(generation===importGeneration)$('#importDialog').close();toast(`Додано деталей у чергу: ${items.length}`);
  }catch(err){if(generation===importGeneration)$('#importError').textContent=err.message+` Збережено ${importDrafts.filter(d=>d.saved).length} із ${items.length}. Повторне натискання продовжить збереження без дублів.`;await refresh();}
  finally{importSaving=false;document.querySelectorAll('[data-remove-draft]').forEach(b=>b.disabled=!!importDrafts[Number(b.closest('[data-draft]').dataset.draft)]?.saved);document.querySelectorAll('[data-close="importDialog"]').forEach(b=>b.disabled=false);if(generation===importGeneration){$('#importSubmit').disabled=false;$('#importFiles').disabled=false;}}
};


$('#importDrafts').addEventListener('pointerover',e=>{
 const heading=e.target.closest('[data-draft-heading]');if(!heading)return;
 closePreview();previewTimer=setTimeout(()=>{
  const draft=importDrafts[Number(heading.closest('[data-draft]').dataset.draft)];if(!draft||draft.manual)return;
  hoverPreview.innerHTML=`<strong>${esc(draft.name)}</strong><p>Завантаження креслення…</p><img alt="Передперегляд PDF">`;
  const img=hoverPreview.querySelector('img'),message=hoverPreview.querySelector('p');
  img.onload=()=>message.hidden=true;img.onerror=()=>{img.hidden=true;message.textContent='Не вдалося показати передперегляд. Перевірте, чи сервер оновлено.';};
  img.src='/staged-preview/'+draft.token;
  const rect=heading.getBoundingClientRect();hoverPreview.style.left=Math.max(8,Math.min(rect.right+16,innerWidth-540))+'px';hoverPreview.style.top=Math.max(8,Math.min(rect.top,innerHeight-440))+'px';hoverPreview.hidden=false;hoverPreview.showPopover();
 },350);
});
$('#importDrafts').addEventListener('pointerout',e=>{if(e.target.closest('[data-draft-heading]'))closePreview();});
$('#importDialog').addEventListener('close',closePreview);

$('#addManualPart').onclick=()=>{
 if(importSaving||importLoading)return;
 const i=importDrafts.length;importDrafts.push({name:'Без PDF',manual:true,requestId:importId()});
 $('#importDrafts').insertAdjacentHTML('beforeend',`<section class="import-part" data-draft="${i}"><div class="import-part-heading"><strong data-draft-heading>Деталь ${i+1} · Без PDF</strong><button type="button" class="secondary small-btn" data-remove-draft>Видалити деталь</button></div><div class="form-grid"><label>Назва деталі *<input data-field="title" required maxlength="200"></label><label>Товщина, мм *<input data-field="thickness" type="number" min="0.01" max="500" step="0.01" required></label><label>Матеріал *<input data-field="material" list="materials" required maxlength="100"></label><label>Кількість, шт. *<input data-field="quantity" type="number" min="1" max="10000000" step="1" value="1" required></label><label>Причина додавання без PDF *<textarea data-field="noPdfReason" required maxlength="4000"></textarea></label></div></section>`);
 $('#importFields').hidden=false;$('#importSubmit').disabled=false;$('#importStatus').textContent='Заповніть дані деталі та причину відсутності PDF.';
};

let importWeldingPreparation=null;
document.body.insertAdjacentHTML('beforeend',`<dialog id="importWeldingDialog"><form id="importWeldingForm"><h2>Підготовка до зварювання</h2><label>Вартість зварювальних робіт, грн<input name="cost" type="number" min="0" step="0.01" placeholder="Можна вказати пізніше"></label><label>Креслення для зварювання<input name="files" type="file" accept=".pdf,application/pdf" multiple></label><p class="muted">Якщо окремих PDF немає, передамо креслення гнуття.</p><p id="importWeldingSaved" class="muted"></p><p id="importWeldingError" class="form-error"></p><div class="dialog-actions"><button type="button" class="secondary" id="cancelImportWelding">Скасувати</button><button type="submit" class="primary">Зберегти</button></div></form></dialog>`);
$('#importForm').elements.sendToWelding.addEventListener('change',e=>{if(!e.target.checked)return;const f=$('#importWeldingForm');f.reset();f.elements.cost.value=importWeldingPreparation?.cost||'';$('#importWeldingSaved').textContent=importWeldingPreparation?.files?.map(f=>f.name).join(', ')||'';$('#importWeldingError').textContent='';$('#importWeldingDialog').showModal();});
$('#cancelImportWelding').onclick=()=>{$('#importForm').elements.sendToWelding.checked=false;$('#importWeldingDialog').close();};
$('#importWeldingDialog').addEventListener('cancel',e=>{if($('#importWeldingForm button[type=submit]').disabled)e.preventDefault();else $('#importForm').elements.sendToWelding.checked=false;});
$('#importWeldingForm').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;$('#cancelImportWelding').disabled=true;try{const f=e.target,files=[...(importWeldingPreparation?.files||[])];for(const file of f.elements.files.files){if(!file.name.toLowerCase().endsWith('.pdf'))throw Error('Оберіть PDF-креслення.');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(Error('Не вдалося прочитати файл'));r.readAsDataURL(file);});files.push({name:file.name,data});}importWeldingPreparation={cost:f.elements.cost.value,files};$('#importWeldingDialog').close();}catch(err){$('#importWeldingError').textContent=err.message;}finally{b.disabled=false;$('#cancelImportWelding').disabled=false;}};
