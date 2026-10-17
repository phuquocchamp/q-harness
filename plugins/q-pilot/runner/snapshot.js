/* DOM snapshot from browser-use/jev-ultrafast (MIT, Copyright (c) 2026 Browser Use).
   q-pilot additions: `scope` and `option` on each action, the occlusion filter, partly visible controls, and
   aria-pressed / aria-current / class-only state, the count of controls hidden under an overlay, and bot-wall detection. */
(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  // Accessible name of the nearest named form, dialog, landmark or list ancestor ("" when none).
  const scopeOf = e => {
    for (let p=e.parentElement; p; p=p.parentElement) {
      if (!p.matches('form,dialog,[role="dialog"],[role="form"],nav,main,aside,header,footer,section,ul,ol,[role="list"],[role="region"],[role="navigation"],[role="search"]')) continue;
      const ref=(p.getAttribute('aria-labelledby')||'').split(/\s+/)
        .map(id=>document.getElementById(id)?.textContent.trim()).filter(Boolean).join(' ');
      const n=ref || p.getAttribute('aria-label') || (p.tagName==='FORM' ? p.id || p.getAttribute('name') : '');
      if (n) return n.replace(/\s+/g,' ').trim();
    }
    return '';
  };
  const actions=[]; let occluded=0;
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    // q-pilot: a control cut by the viewport edge (a booking form's From/To below the fold) still counts when at
    // least 8 px of it shows; it is hit-tested at the centre of its visible part, and the click scrolls it into view.
    const r=e.getBoundingClientRect(), rname=role(e);
    const vt=Math.max(r.top,0), vb=Math.min(r.bottom,innerHeight), vl=Math.max(r.left,0), vr=Math.min(r.right,innerWidth);
    if (!rname || r.width<=0 || r.height<=0 || vb-vt<8 || vr-vl<8) continue;
    const x=(vl+vr)/2, y=(vt+vb)/2;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    // q-pilot: drop an element whose centre is covered by something else (an overlay, a modal backdrop).
    const top=document.elementFromPoint(x,y);
    // A custom checkbox or radio is covered by a styled element inside its own label: that still counts as hittable.
    if (!top || (top!==e && !e.contains(top) && top.closest('label')?.control!==e)) { occluded++; continue; }
    const base={node:identity(e),role:rname,label:name(e)||rname,scope:scopeOf(e),
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    // q-pilot: also aria-pressed and aria-current (toggle buttons, the current page or step).
    for (const key of ['checked','selected','expanded','pressed','current']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null && !(key==='current' && value==='false')) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    // q-pilot: a segmented control styled only by class (a booking form's "One way" with class "_active_x9") has
    // no ARIA state at all; without this Jev cannot tell which option is on.
    if (!['checked','selected','pressed','current'].some(k=>k in base) &&
        [...e.classList].some(c=>/(^|[_-])(active|selected|current|checked)([_-]|$)/i.test(c))) base.selected='true';
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,option:o.label,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      // Like jev-ultrafast: every editable field can also be clicked ("Open ..."), which is how a date or place
      // field that opens a picker on click is reached.
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label,open:true});
    }
  }
  // q-pilot: custom widgets (a booking site's airport list, a date cell) are often plain divs that only show a
  // pointer cursor. The outermost such element in view that holds no real control is offered as role "clickable".
  const seenNodes=new Set(actions.map(a=>cache.nodes.get(a.node)));
  const all=document.body.getElementsByTagName('*');
  for (let i=0, n=0; i<all.length && n<4000; i++) {
    const e=all[i];
    if (e.matches(selector) || e.closest(selector) || seenNodes.has(e)) continue;
    const r=e.getBoundingClientRect();
    if (r.width<8 || r.height<8 || r.bottom<=0 || r.top>=innerHeight || r.right<=0 || r.left>=innerWidth) continue;
    n++;
    if (getComputedStyle(e).cursor!=='pointer' || (e.parentElement && getComputedStyle(e.parentElement).cursor==='pointer')) continue;
    if (e.querySelector(selector) || !visible(e)) continue;
    const label=name(e).replace(/\s+/g,' ').trim();
    if (!label || label.length>200) continue;
    const vt=Math.max(r.top,0), vb=Math.min(r.bottom,innerHeight), vl=Math.max(r.left,0), vr=Math.min(r.right,innerWidth);
    const top=document.elementFromPoint((vl+vr)/2,(vt+vb)/2);
    if (!top || (top!==e && !e.contains(top))) continue;
    actions.push({node:identity(e),role:'clickable',label,scope:scopeOf(e),rect:{x:r.x,y:r.y,w:r.width,h:r.height},kind:'click',value:''});
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  // q-pilot: a bot wall (a CAPTCHA or challenge page) is named, so the run can stop for a person instead of
  // clicking around a page it cannot see (DataDome's CAPTCHA sits in an iframe the element list never shows).
  const WALLS=[[/captcha-delivery\.com/,'datadome'],[/challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\//,'cloudflare'],
    [/hcaptcha\.com\/captcha/,'hcaptcha'],[/recaptcha\/(api2|enterprise)\/bframe/,'recaptcha'],[/arkoselabs|funcaptcha/,'arkose']];
  let wall=null;
  for (const f of document.querySelectorAll('iframe')) {
    const r=f.getBoundingClientRect();
    if (wall || r.width<60 || r.height<60 || !visible(f)) continue;
    for (const [re,n] of WALLS) if (re.test(f.src||'')) wall=n;
  }
  // A CAPTCHA drawn in the page itself (AWS WAF's <awswaf-captcha> shadow root on Traveloka): any visible, sizable
  // element whose tag, id or class names a captcha.
  if (!wall) for (const e of document.querySelectorAll('awswaf-captcha,[id*="captcha" i],[class*="captcha" i]')) {
    const r=e.getBoundingClientRect();
    if (r.width>=100 && r.height>=100 && r.bottom>0 && r.top<innerHeight && visible(e)) {
      wall=e.tagName==='AWSWAF-CAPTCHA' ? 'aws-waf' : 'captcha'; break;
    }
  }
  if (!wall && (/^(just a moment|attention required|access denied|one more step)/i.test(document.title) ||
    document.querySelector('#challenge-form,#cf-challenge-running,#px-captcha'))) wall='challenge';
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions,occluded,wall};
})()
