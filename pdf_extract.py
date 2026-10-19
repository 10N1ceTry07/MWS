"""Offline, conservative extraction of explicitly labelled drawing fields."""
import io
import re
from pypdf import PdfReader, PdfWriter
from pypdf._text_extraction import mult

NUMBER = r'\d+(?:[.,]\d+)?'

def repair_encoding(text):
    # Some CAD PDFs expose CP1251 glyph codes as Latin-1 (Лист -> Ëèñò).
    def fix(match):
        word = match.group()
        try:
            repaired = word.encode('latin1').decode('cp1251')
            if len(re.findall(r'[А-Яа-яІіЇїЄє]', repaired)) >= 2:
                return repaired
        except (UnicodeError, LookupError):
            pass
        return word
    return re.sub(r'[\u00a0-\u00ff]+', fix, text)

def clean_title(text):
    text = re.sub(r'^\d+\s*[-_]?\s*[xх×]\s*[-_]?', '', text.strip(), flags=re.I)
    text = re.sub(r'\s*[-_]\s*\d+\s*шт\.?\s*$', '', text, flags=re.I)
    return re.sub(r'\.(?:ipt|sldprt)$', '', text, flags=re.I).strip()

def numeric(value):
    value = float(value.replace(',', '.'))
    return value if 0 < value <= 500 else None

def title_thickness(title):
    # Only the material/thickness slot, never arbitrary dimensions such as _35mm.
    match = re.search(r'(?:steel|aluminium|aluminum|alu|stainless|сталь|алюміній)[_-]('+NUMBER+r')\s*(?:mm|мм)(?=[_\s-]|$)', title, re.I)
    if not match:
        match = re.match(r'('+NUMBER+r')\s*(?:mm|мм)(?=[_\s-]|$)', title, re.I)
    return numeric(match.group(1)) if match else None

def positioned_fields(chunks):
    titles, thicknesses = [], []
    for label, x, y in chunks:
        key = label.strip().lower()
        if key not in ('title:', 'назва деталі:', 'thickness(mm):', 'part no.:'):
            continue
        right = [(t,px,py) for t,px,py in chunks if 10 < px-x < 240 and abs(py-y)<5 and t.strip()]
        right.sort(key=lambda item:item[1])
        if key == 'thickness(mm):':
            for t,px,py in right:
                match = re.fullmatch(r'('+NUMBER+r')(?:\s*(?:mm|мм)\.?\s*(?:plate)?)?',t.strip(),re.I)
                if match:
                    thicknesses.append(numeric(match.group(1)))
                    break
        elif right:
            candidate = right[0][0].strip()
            if len(candidate)>2 and re.search(r'[A-Za-zА-Яа-я]',candidate) and ':' not in candidate and not re.match(r'^(?:SCALE|DWG|SHEET|A[0-4]\b|WEIGHT|MATERIAL)',candidate,re.I):
                titles.append(clean_title(candidate))
    return titles, [t for t in thicknesses if t is not None]

TITLE = re.compile(r'(?:назва\s*(?:деталі|виробу)?|найменування\s*(?:деталі|виробу)?|наименование\s*(?:детали|изделия)?|part\s*name|description)\s*[:=\-]?\s*(.*)', re.I)
THICK = re.compile(r'(?:товщина(?:\s+матеріалу)?|толщина(?:\s+материала)?|thickness)\s*(?:[,\[(]\s*(?:мм|mm)\s*[\])]?)?\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)\s*(мм|mm|см|cm|in|inch|дюйм)?\b|(?<!\w)[sStTδ]\s*=\s*(\d+(?:[.,]\d+)?)\s*(мм|mm|см|cm|in|inch|дюйм)?\b', re.I)

def parse_text(text):
    text = repair_encoding(text)
    # Normalize only field labels, preserving original part designations.
    text = re.sub(r'[TТ][hһ][iі][cс][kк][nп][eе][sѕ][sѕ](?=\s*[:(])', 'Thickness', text, flags=re.I)
    titles, thicknesses = [], []
    lines = [re.sub(r'[ \t]+', ' ', x).strip() for x in text.splitlines() if x.strip()]
    for i, line in enumerate(lines):
        name_match=re.match(r'Name\s*:\s*(.+)',line,re.I)
        if name_match:titles.append(name_match.group(1))
        match = TITLE.match(line)
        if match:
            value = match.group(1).strip(' :;|')
            if not value and i + 1 < len(lines) and not line.lower().startswith('description'):
                value = lines[i + 1]
            if value and len(value) <= 200 and not re.match(r'(?:товщина|толщина|матеріал|материал|thickness|material|масштаб|маса|mass)\b', value, re.I) and not re.fullmatch(r'\d+\s*:\s*\d+',value):
                titles.append(value)
    # Inventor drawing block: company, mass, part designation, material/designer.
    if 'Designed by' in text and 'Tolerances DIN ISO' in text:
        for i,line in enumerate(lines[:-1]):
            if re.fullmatch(r'N/A|'+NUMBER+r'\s*kg',line,re.I):
                candidate=lines[i+1]
                if re.search(r'[A-Za-zА-Яа-я]',candidate) and not candidate.startswith(('Steel','Generic')):
                    titles.append(candidate)
    # SolidWorks default block stores the DWG NO value after the empty WEIGHT label.
    if 'DWG NO.' in text and 'TITLE:' in text:
        for i,line in enumerate(lines[:-1]):
            if re.fullmatch(r'WEIGHT\s*:',line,re.I):
                candidate=lines[i+1]
                if len(candidate)>2 and re.search(r'[A-Za-zА-Яа-я]',candidate) and ':' not in candidate:
                    titles.append(candidate)
    # CAD names can wrap inside a stamp; material-coded names identify their start.
    encoded=[]
    for i,line in enumerate(lines):
        if re.match(r'(?:\d+\s*[-_]?[xх]\s*[-_]?)?(?:[A-Z]+\d+[_-])?(?:ALU|Steel|Aluminium|Aluminum)[_-]'+NUMBER+r'(?:мм|mm)[_-]',line,re.I):
            parts=[line]
            for following in lines[i+1:i+3]:
                if re.fullmatch(r'\d+(?:[.,]\d+)?[хx×]\d+(?:[хx×]\d+)?',following,re.I) or (re.match(r'^[а-яіїєґ]',following) and ':' not in following):
                    parts.append(following)
                else:break
            encoded.append(' '.join(parts))
    if encoded:titles=encoded
    for match in (m for line in lines if not re.search(r'coating|покритт|покрыти|oxidation|paint',line,re.I) for m in THICK.finditer(line)):
        value = float((match.group(1) or match.group(3)).replace(',', '.'))
        unit = (match.group(2) or match.group(4) or 'мм').lower()
        if unit not in ('мм', 'mm'):
            continue
        if 0 < value <= 500:
            thicknesses.append(value)
    for match in re.finditer(r'\b(?:лист|sheet|plate)\s+('+NUMBER+r')\s*(?:мм|mm)\b',text,re.I):
        value=numeric(match.group(1))
        if value is not None: thicknesses.append(value)
    # Sheet designation in a fraction-style GOST title block: thickness above,
    # steel grade below; "Лист" can follow the denominator in extracted order.
    for i,line in enumerate(lines):
        match=re.fullmatch(r'(?:Лист\s*)?('+NUMBER+r')\s+(?:ГОСТ|GOST)\s+1990[34][–-]\d+',line,re.I)
        if match and re.search(r'Лист',' '.join(lines[max(0,i-2):i+3]),re.I):
            value=numeric(match.group(1))
            if value is not None:thicknesses.append(value)
    titles=[clean_title(t) for t in titles]
    thicknesses.extend(value for t in titles if (value:=title_thickness(t)) is not None)
    return {'titles': list(dict.fromkeys(titles)), 'thicknesses': list(dict.fromkeys(thicknesses))}

def read_quantities(text):
    values=re.findall(r'(?:кількість|количество|quantity|qty)\s*[:=]?\s*(\d+)\b',text,re.I)
    values+=re.findall(r'(?<![\d.,])(\d+)\s*(?:шт\.?|pcs|pieces)(?!\w)',text,re.I)
    return sorted({int(v) for v in values if 0<int(v)<=10000000})

def filename_fallback(result, name):
    name=re.sub(r'\.pdf$','',name,flags=re.I)
    thicknesses=[]
    for match in re.finditer(r'(?<![\w.,])('+NUMBER+r')\s*(?:мм|mm)(?![a-zа-я])',name.replace('_',' '),re.I):
        # A dimension such as 100x200mm is not a sheet thickness.
        prefix=name.replace('_',' ')[:match.start()]
        if re.search(r'\d\s*[xх×]\s*$',prefix,re.I):continue
        value=numeric(match.group(1))
        if value is not None:thicknesses.append(value)
    quantities=read_quantities(name.replace('_',' '))
    prefix=re.match(r'^(\d+)\s*[xх×](?=[^\d]|$)',name,re.I)
    if prefix and 0<int(prefix.group(1))<=10000000:quantities.append(int(prefix.group(1)))
    for field,values in [('thicknesses',thicknesses),('quantities',quantities)]:
        if result.get(field):result[field+'Source']='pdf'
        else:
            result[field]=sorted(set(values))
            result[field+'Source']='filename' if values else 'manual'
    return result

def extract(content):
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted and not reader.decrypt(''):
            return {'titles': [], 'thicknesses': [], 'message': 'PDF захищений паролем. Введіть дані вручну.'}
        texts, titles, thicknesses, materials = [], [], [], []
        for page in reader.pages:
            chunks=[]
            def visit(text,cm,tm,font,size):
                matrix=mult(tm,cm)
                if text.strip():chunks.append((repair_encoding(text.strip()),matrix[4],matrix[5]))
            text=page.extract_text(visitor_text=visit) or ''
            texts.append(text)
            found=parse_text(text)
            materials.extend(read_materials(text,found['titles']))
            spatial_titles,spatial_thickness=positioned_fields(chunks)
            # Spatial cell reading avoids confusing thickness with area or scale.
            titles.extend(spatial_titles or found['titles'])
            thicknesses.extend(spatial_thickness or found['thicknesses'])
        result={'titles':list(dict.fromkeys(titles)), 'thicknesses':list(dict.fromkeys(thicknesses)), 'materials':list(dict.fromkeys(materials))}
        result['quantities']=read_quantities(repair_encoding('\n'.join(texts)))
        warnings=[]
        if any(re.search(r'\basm\b',t,re.I) for t in result['titles']):
            warnings.append('Складальне креслення (asm): перевірте, чи потрібна ця сторінка як окрема позиція гнуття. Товщина з інших сторінок не переноситься.')
        if not ''.join(texts).strip():warnings.append('PDF без текстового шару (скан або текст перетворено на контури). Введіть дані вручну.')
        if len(result['titles'])>1 and len(reader.pages)>1:warnings.append(f'У PDF {len(reader.pages)} сторінок із різними назвами. Файл залишиться однією позицією; перевірте, яку деталь додаєте.')
        if not result['thicknesses'] and any(re.search(r'\bR\s*=?\s*\d',t,re.I) for t in texts):warnings.append('Є позначення радіуса R, але товщину не знайдено. Радіус гнуття не є товщиною — введіть її вручну.')
        result['message']=' '.join(warnings)
        return result
    except Exception:
        return {'titles': [], 'thicknesses': [], 'message': 'Не вдалося прочитати текст PDF. Введіть дані вручну.'}

def read_materials(text,titles):
    text=repair_encoding(text)
    text=re.sub(r'[MМ][aа][tт][eе][rг][iі][aа][lӏ](?=\s*:)', 'Material',text,flags=re.I)
    values=[]
    for line in text.splitlines():
        line=line.strip()
        steel=re.fullmatch(r'(?:Лист\s*)?(Сталь\s+[\w.-]+\s+ГОСТ\s+\d+[–-]\d+)(?:\s*Лист)?',line,re.I)
        if steel:
            values.append(steel.group(1))
            continue
        match=re.match(r'(?:Material|Матеріал|Материал)\s*:\s*(.+)',line,re.I)
        if match:values.append(match.group(1).strip())
        elif re.search(r'Material:\s*$',line,re.I):
            value=re.sub(r'Material:\s*$','',line,flags=re.I).strip()
            if value:values.append(value)
        elif re.match(r'^Лист\s+'+NUMBER+r'\s*мм',line,re.I):
            value=re.sub(r'^Лист\s+'+NUMBER+r'\s*мм\s*','',line,flags=re.I).strip()
            if value:values.append('Сталь '+value)
        elif 'Designed by' in text:
            match=re.match(r'^(Steel(?:,\s*(?:Galvanized|Mild))?)(?=[A-Z]|$)',line)
            if match:values.append({'Steel':'Сталь','Steel, Mild':'Сталь','Steel, Galvanized':'Оцинкована сталь'}.get(match.group(1),match.group(1)))
    if not values:
        for title in titles:
            if re.search(r'(?:^|_)(?:ALU|Aluminium|Aluminum)_',title,re.I):values.append('Алюміній')
            elif re.search(r'(?:^|_)Steel_',title,re.I):values.append('Сталь')
    return list(dict.fromkeys(v for v in values if v and len(v)<=100))

def iter_split_pages(content, name):
    """Return real single-page PDF bytes; never silently duplicate the full drawing."""
    try:
        reader=PdfReader(io.BytesIO(content))
        if reader.is_encrypted and not reader.decrypt(''):
            raise ValueError('PDF захищений паролем. Завантажте незахищену копію.')
        count=len(reader.pages)
    except ValueError:
        raise
    except Exception:
        # An unreadable document still permits the established manual fallback.
        yield (name, content, None, 1)
        return
    if count<1:
        raise ValueError('PDF не містить сторінок.')
    if count==1:
        yield (name,content,1,1)
        return
    for i,page in enumerate(reader.pages):
        writer=PdfWriter();writer.add_page(page)
        out=io.BytesIO();writer.write(out)
        yield (f'{name[:-4][:160]} — сторінка {i+1}.pdf',out.getvalue(),i+1,count)

def split_pages(content, name):
    return list(iter_split_pages(content,name))
