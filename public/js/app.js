const store={
  state:null,
  providerPage:1,
  providerSearch:'',
  expandedProviders:new Set(),
  sessionStatusCache:[],
  sessionMeta:{agents:[],agent:'',page:1,pageSize:20,total:0,pages:1,search:'',choices:[]},
  csrfToken:'',
  readableLogEvents:[],
  agentStatus:{},
};
const PROVIDER_PAGE_SIZE=2;
const $=id=>document.getElementById(id);
const STATIC_EVENT_HANDLERS = {
  1: function(event){event.preventDefault();login(this.querySelector?.('#loginBtn')||$('loginBtn'))},
  2: function(event){toggleSideMenu(false)},
  3: function(event){goSection('currentSection',this)},
  4: function(event){goSection('workStatusSection',this)},
  5: function(event){goSection('sessionResumeSection',this)},
  6: function(event){goSection('addSection',this)},
  7: function(event){goSection('providersSection',this)},
  8: function(event){goSection('testSection',this)},
  9: function(event){goSection('imageGenSection',this)},
  10: function(event){goSection('chatToolsSection',this)},
  11: function(event){goSection('agentToolsSection',this)},
  12: function(event){goSection('agentSkillsSection',this)},
  13: function(event){goSection('readableLogsSection',this)},
  14: function(event){goSection('commandsSection',this)},
  15: function(event){goSection('settingsSection',this)},
  16: function(event){logout()},
  73: function(event){goSection('approvalSettingsSection',this)},
  74: function(event){saveApprovalSettings(this)},
  75: function(event){loadApprovalSettings()},
  17: function(event){toggleSideMenu(true)},
  18: function(event){loadState()},
  19: function(event){createAgent()},
  20: function(event){loadWorkStatus()},
  21: function(event){loadSessionResume()},
  22: function(event){sessionAgentChanged()},
  23: function(event){if(event.key==='Enter')searchSessions()},
  24: function(event){searchSessions()},
  25: function(event){sessionPageSizeChanged()},
  26: function(event){fetchModelsForAdd(this)},
  27: function(event){addProvider()},
  28: function(event){providerSearchChanged()},
  29: function(event){jumpProvider(this.value)},
  30: function(event){gotoProviderPage(1)},
  31: function(event){gotoProviderPage(store.providerPage-1)},
  32: function(event){gotoProviderPage(this.value)},
  33: function(event){gotoProviderPage(store.providerPage+1)},
  34: function(event){gotoProviderPage(999999)},
  35: function(event){runTest(this)},
  36: function(event){toggleTestLog()},
  37: function(event){clearTestLog()},
  38: function(event){toggleTestLog(false)},
  39: function(event){loadChatPlatforms()},
  40: function(event){loadAgentTools()},
  41: function(event){loadAgentSkills()},
  42: function(event){loadReadableLogs()},
  43: function(event){loadReadableLogs()},
  44: function(event){renderReadableLogs()},
  45: function(event){loadReadableLogs()},
  46: function(event){openCommandsPage()},
  47: function(event){toggleUsage()},
  48: function(event){saveAuthSettings(this)},
  49: function(event){logoutAll(this)},
  50: function(event){syncPairingScope()},
  51: function(event){saveServiceScope()},
  52: function(event){loadGatewayLogs()},
  53: function(event){resetPairingInput()},
  54: function(event){normalizePairingCode(this)},
  55: function(event){if(event.key==='Enter'){event.preventDefault();approvePairing()}},
  56: function(event){approvePairing()},
  57: function(event){rebuildCommands()},
  58: function(event){loadState()},
  59: function(event){installGateway()},
  60: function(event){restartGateway(this)},
  61: function(event){closeMimoAudio()},
  62: function(event){closeMimoAudio()},
  63: function(event){runAsr(this)},
  64: function(event){runTts(this)},
  65: function(event){closeCommandsPage()},
  66: function(event){closeCommandsPage()},
  67: function(event){resolveConfirm(false)},
  68: function(event){resolveConfirm(false)},
  69: function(event){resolveConfirm(true)},
  70: function(event){toggleTheme()},
  71: function(event){checkPanelUpdate(this)},
  72: function(event){runPanelUpdate(this)},
};
function installStaticEventHandlers(){
  for(const type of ['click','change','input','keydown','submit']){
    document.addEventListener(type,event=>{
      const element=event.target.closest(`[data-static-${type}]`);
      if(!element)return;
      STATIC_EVENT_HANDLERS[element.dataset[`static${type[0].toUpperCase()}${type.slice(1)}`]]?.call(element,event);
    });
  }
}
installStaticEventHandlers();
const THEME_KEY='hermes-theme';
const THEME_MEDIA=window.matchMedia('(prefers-color-scheme:dark)');
function preferredTheme(){const saved=window.localStorage.getItem(THEME_KEY);return saved==='dark'||saved==='light'?saved:(THEME_MEDIA.matches?'dark':'light')}
function applyTheme(theme){const value=theme==='dark'?'dark':'light';document.documentElement.dataset.theme=value;document.documentElement.style.colorScheme=value;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',value==='dark'?'#11161c':'#f4f6f8');const btn=$('themeToggle');if(btn){const label=value==='dark'?'日间模式':'夜间模式';const icon=btn.querySelector('.themeIcon');const text=btn.querySelector('.themeLabel');if(icon)icon.innerHTML=value==='dark'?'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>':'<svg viewBox="0 0 24 24"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/></svg>';if(text)text.textContent=label;btn.setAttribute('aria-label','切换'+label);btn.title='切换'+label}}
function toggleTheme(){const next=document.documentElement.dataset.theme==='dark'?'light':'dark';window.localStorage.setItem(THEME_KEY,next);applyTheme(next)}
let PANEL_UPDATE_INFO=null,PANEL_UPDATE_WORKING=false,PANEL_CHECK_PROMISE=null;
function shortSha(sha){return String(sha||'').slice(0,8)||'-'}
function formatRollbackTime(id){const m=String(id||'').match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);if(!m)return id;const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]));return d.toLocaleString('zh-CN',{hour12:false})}
function renderPanelRollbacks(items=[]){const box=$('versionRollbackList');if(!box)return;box.innerHTML='<div class="versionRollbackTitle"><span>可回滚版本</span><small>最多保留 2 份</small></div>'+(items.length?items.map(x=>`<div class="versionRollbackItem"><span><b>v${esc(x.version)} · ${esc(shortSha(x.sha))}</b><small>${esc(formatRollbackTime(x.id))}</small></span><button type="button" data-rollback-id="${esc(x.id)}" data-rollback-version="${esc(x.version)}">回滚到此版本</button></div>`).join(''):'<div class="versionRollbackEmpty">暂无可回滚版本<br><small>本机尚未通过在线更新产生历史版本</small></div>')}
function setPanelUpdateWorking(working,label='处理中…'){PANEL_UPDATE_WORKING=working;$('versionProgress')?.classList.toggle('hidden',!working);const text=$('versionProgress')?.querySelector('span');if(text)text.textContent=label;const action=$('versionActionBtn');if(action)action.disabled=working;document.querySelector('.versionControl')?.classList.toggle('working',working)}
function renderPanelUpdate(r){PANEL_UPDATE_INFO=r;const version='v'+String(r.version||'-');for(const id of ['sidePanelVersion','versionPopoverNumber','panelUpdateVersion']){const el=$(id);if(el)el.textContent=version}const hint=$('versionPopoverHint'),mark=$('versionStatusMark'),badgeState=$('versionBadgeState'),sha=$('versionCurrentSha'),dot=$('versionUpdateDot'),run=$('versionActionBtn'),latestRow=$('versionLatestRow'),latestNumber=$('versionLatestNumber'),latestSha=$('versionLatestSha');dot?.classList.toggle('hidden',!r.update_available);latestRow?.classList.toggle('hidden',!r.update_available);if(latestNumber)latestNumber.textContent='v'+String(r.latest_version||r.remote_version||r.version||'-');if(latestSha)latestSha.textContent=shortSha(r.latest_sha);if(sha)sha.textContent=shortSha(r.installed_sha||r.latest_sha);if(mark){mark.textContent=r.update_available?'可更新':'最新版';mark.classList.toggle('updateAvailable',!!r.update_available)}if(badgeState)badgeState.textContent=r.update_available?'有更新':'最新版';if(r.update_available){hint.textContent=`发现新版本 ${shortSha(r.latest_sha)}，当前 ${shortSha(r.installed_sha)}。`;run.classList.add('primary');run.innerHTML='<span>↑</span><span>立即更新到 v'+esc(String(r.latest_version||r.remote_version||r.version||'-'))+'</span>'}else{hint.textContent='当前代码与 GitHub 最新版本一致。';run.classList.remove('primary');run.innerHTML='<span>↻</span><span>检查更新</span>'}if(r.status?.state==='failed')hint.textContent=`${r.status.operation==='rollback'?'回滚':'更新'}失败：${r.status.message||'未知错误'}`;renderPanelRollbacks(r.rollbacks||[]);const oldHint=$('panelUpdateHint'),oldRun=$('runPanelUpdateBtn');if(oldHint)oldHint.textContent=hint.textContent;if(oldRun)oldRun.classList.toggle('hidden',!r.update_available)}
function checkPanelUpdate(){if(PANEL_UPDATE_WORKING)return Promise.resolve();if(PANEL_CHECK_PROMISE)return PANEL_CHECK_PROMISE;PANEL_CHECK_PROMISE=(async()=>{const started=window.performance.now();const hint=$('versionPopoverHint'),badgeState=$('versionBadgeState'),refresh=$('versionActionBtn');try{refresh.disabled=true;refresh.classList.add('checking');refresh.setAttribute('aria-busy','true');refresh.innerHTML='<span class="versionCheckSpinner" aria-hidden="true"></span><span>正在检查…</span>';if(hint){hint.classList.remove('checkDone');hint.textContent='正在连接 GitHub 检查最新版本…'}if(badgeState)badgeState.textContent='检查中';document.querySelector('.versionControl')?.classList.add('checking');const r=await api('/panel-update');const wait=Math.max(0,700-(window.performance.now()-started));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));renderPanelUpdate(r);hint?.classList.add('checkDone');return r}catch(e){if(hint){hint.textContent=e.message;hint.classList.add('checkDone')}if(badgeState)badgeState.textContent='检查失败';toast(e.message)}finally{refresh.disabled=false;refresh.classList.remove('checking');refresh.removeAttribute('aria-busy');refresh.innerHTML=PANEL_UPDATE_INFO?.update_available?'<span aria-hidden="true">↑</span><span>立即更新到 v'+esc(String(PANEL_UPDATE_INFO.latest_version||PANEL_UPDATE_INFO.remote_version||PANEL_UPDATE_INFO.version||'-'))+'</span>':'<span aria-hidden="true">↻</span><span>检查更新</span>';document.querySelector('.versionControl')?.classList.remove('checking');PANEL_CHECK_PROMISE=null}})();return PANEL_CHECK_PROMISE}
async function runPanelUpdate(btn){if(!PANEL_UPDATE_INFO?.latest_sha){await checkPanelUpdate($('versionActionBtn'));if(!PANEL_UPDATE_INFO?.latest_sha)return}if(!await askConfirm(`确定将面板更新到 ${shortSha(PANEL_UPDATE_INFO.latest_sha)}？\n更新期间页面会暂时断开；若更新失败，系统将自动回滚。`,{title:'确认更新',confirmText:'立即更新'}))return;try{await api('/panel-update',{method:'POST',body:JSON.stringify({expected_sha:PANEL_UPDATE_INFO.latest_sha}),sourceButton:btn});$('versionPopoverHint').textContent='更新已启动，正在下载并验证…';setPanelUpdateWorking(true,'正在下载与安装');setTimeout(waitForPanelUpdate,2500)}catch(e){toast(e.message)}}
async function runPanelRollback(id,version,btn){if(PANEL_UPDATE_WORKING)return;if(!await askConfirm(`确定回滚到 v${version}？\n当前版本会转为可回滚备份；若回滚失败，系统将自动恢复。`,{title:'确认回滚',confirmText:'开始回滚',tone:'warning'}))return;try{await api('/panel-rollback',{method:'POST',body:JSON.stringify({id}),sourceButton:btn});$('versionPopoverHint').textContent=`正在回滚到 v${version}…`;setPanelUpdateWorking(true,'正在切换并验证');setTimeout(waitForPanelUpdate,2000)}catch(e){toast(e.message)}}
async function waitForPanelUpdate(){for(let i=0;i<60;i++){try{const r=await api('/panel-update');if(r.status?.state==='success'){setPanelUpdateWorking(false);location.reload();return}if(r.status?.state==='failed'){renderPanelUpdate(r);setPanelUpdateWorking(false);toast(r.status.message||'操作失败');return}const message=r.status?.message||'处理中…';$('versionPopoverHint').textContent=message;const text=$('versionProgress')?.querySelector('span');if(text)text.textContent=message}catch{}await new Promise(resolve=>setTimeout(resolve,2000))}setPanelUpdateWorking(false);$('versionPopoverHint').textContent='任务仍在后台执行，请稍后重新检查。'}
function toggleVersionPopover(force){const pop=$('versionPopover'),btn=$('versionBadgeBtn');if(!pop)return;const show=force===undefined?pop.classList.contains('hidden'):!!force;pop.classList.toggle('hidden',!show);btn?.setAttribute('aria-expanded',String(show));if(show&&!PANEL_UPDATE_INFO)checkPanelUpdate($('versionActionBtn'))}
$('versionBadgeBtn')?.addEventListener('click',e=>{e.stopPropagation();toggleVersionPopover()});$('versionRollbackList')?.addEventListener('click',e=>{const btn=e.target.closest('[data-rollback-id]');if(btn)runPanelRollback(btn.dataset.rollbackId,btn.dataset.rollbackVersion,btn)});document.addEventListener('click',e=>{const action=e.target.closest('#versionActionBtn');if(action){PANEL_UPDATE_INFO?.update_available?runPanelUpdate(action):checkPanelUpdate();return}if(!e.target.closest('.versionControl'))toggleVersionPopover(false)});
applyTheme(preferredTheme());
const syncSystemTheme=()=>{if(!window.localStorage.getItem(THEME_KEY))applyTheme(THEME_MEDIA.matches?'dark':'light')};
if(THEME_MEDIA.addEventListener)THEME_MEDIA.addEventListener('change',syncSystemTheme);else THEME_MEDIA.addListener(syncSystemTheme);
const API_BASE=(document.querySelector('base')?.getAttribute('href')||window.location.pathname).replace(/\/$/,'')+'/api';
let CONFIRM_RESOLVE=null,CONFIRM_FOCUS=null;
function askConfirm(message,options={}){if(CONFIRM_RESOLVE)return Promise.resolve(false);return new Promise(resolve=>{CONFIRM_RESOLVE=resolve;CONFIRM_FOCUS=document.activeElement;const modal=$('confirmModal');$('confirmTitle').textContent=options.title||'确认操作';$('confirmOkBtn').textContent=options.confirmText||'继续';$('confirmMessage').textContent=String(message).replace(/\\n/g,'\n');modal.dataset.tone=options.tone||'default';openModal('confirmModal','confirmOkBtn');})}
function resolveConfirm(ok){if(!CONFIRM_RESOLVE)return;const done=CONFIRM_RESOLVE;CONFIRM_RESOLVE=null;closeModal('confirmModal');if(!ok)toast('已取消');done(!!ok)}
function emptyState(title,detail=''){return `<div class="emptyStatePanel"><span>◇</span><b>${esc(title)}</b>${detail?`<small>${esc(detail)}</small>`:''}</div>`}
function animateRenderedItems(root){if(!root||window.matchMedia('(prefers-reduced-motion:reduce)').matches)return;const items=[...root.querySelectorAll(':scope > .provider,:scope > .agentCard,:scope > .workCard,:scope > .sessAgent,:scope > .result,:scope > .readableEvent,:scope > .modelItem')].slice(0,12);items.forEach((el,index)=>{el.classList.remove('motion-item-in');el.style.animationDelay=`${Math.min(index*28,196)}ms`;void el.offsetWidth;el.classList.add('motion-item-in');el.addEventListener('animationend',()=>{el.classList.remove('motion-item-in');el.style.animationDelay=''},{once:true})})}
let OPEN_MODAL=null,MODAL_FOCUS=null,MODAL_CLOSE_TIMER=null;
function modalFocusable(modal){return [...modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x=>!x.disabled&&!x.hidden)}
function openModal(id,focusId){const modal=$(id);if(!modal)return;clearTimeout(MODAL_CLOSE_TIMER);modal.classList.remove('is-closing');modal.removeAttribute('aria-hidden');MODAL_FOCUS=document.activeElement;OPEN_MODAL=modal;modal.classList.remove('hidden');requestAnimationFrame(()=>modal.classList.add('show'));$('app')?.setAttribute('inert','');$('login')?.setAttribute('inert','');requestAnimationFrame(()=>$(focusId)?.focus?.()||modalFocusable(modal)[0]?.focus())}
function closeModal(id){const modal=$(id);if(!modal||modal.classList.contains('hidden')||modal.classList.contains('is-closing'))return;const panel=modal.querySelector('.modalPanel');let finished=false;const finish=()=>{if(finished)return;finished=true;clearTimeout(MODAL_CLOSE_TIMER);panel?.removeEventListener('animationend',onEnd);modal.classList.remove('is-closing','show');modal.classList.add('hidden');modal.setAttribute('aria-hidden','true');if(OPEN_MODAL===modal)OPEN_MODAL=null;$('app')?.removeAttribute('inert');$('login')?.removeAttribute('inert');const focus=MODAL_FOCUS;MODAL_FOCUS=null;requestAnimationFrame(()=>focus?.focus?.())};const onEnd=e=>{if(e.target===panel&&e.animationName==='dialog-out')finish()};modal.classList.add('is-closing');if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return finish();panel?.addEventListener('animationend',onEnd);MODAL_CLOSE_TIMER=setTimeout(finish,260)}
document.addEventListener('keydown',e=>{if(e.key==='Tab'&&OPEN_MODAL){const list=modalFocusable(OPEN_MODAL);if(!list.length){e.preventDefault();return}const first=list[0],last=list[list.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}return}if(e.key==='Escape'){if(CONFIRM_RESOLVE)return resolveConfirm(false);if(!$('commandsModal')?.classList.contains('hidden'))return closeCommandsPage();if(!$('mimoModal')?.classList.contains('hidden'))return closeMimoAudio();toggleSideMenu(false)}});
let MENU_SCROLL_Y=0,MENU_IS_OPEN=false,MENU_CLOSE_TOKEN=0,MENU_CLOSE_TIMER=null;
function setMenuPageLock(lock){
  if(lock){
    if(MENU_IS_OPEN)return;
    MENU_SCROLL_Y=window.scrollY||0;
    MENU_IS_OPEN=true;
    document.documentElement.classList.add('menuOpen');document.body.classList.add('menuOpen');
    document.body.style.position='fixed';document.body.style.top=`-${MENU_SCROLL_Y}px`;document.body.style.left='0';document.body.style.right='0';document.body.style.width='100%';
  }else{
    if(!MENU_IS_OPEN)return;
    document.documentElement.classList.remove('menuOpen');document.body.classList.remove('menuOpen');
    const y=MENU_SCROLL_Y;document.body.style.position='';document.body.style.top='';document.body.style.left='';document.body.style.right='';document.body.style.width='';MENU_SCROLL_Y=0;MENU_IS_OPEN=false;window.scrollTo(0,y);
  }
}
function toggleSideMenu(open){const m=$('sideMenu');const shade=$('menuShade');const btn=$('mobileMenuBtn');if(!m)return;clearTimeout(MENU_CLOSE_TIMER);const token=++MENU_CLOSE_TOKEN;if(!MOBILE_MENU_MQ.matches){m.classList.remove('open');m.removeAttribute('aria-hidden');m.inert=false;shade?.classList.remove('show');btn?.setAttribute('aria-expanded','false');setMenuPageLock(false);return}const show=open===undefined?!MENU_IS_OPEN:!!open;if(show){m.inert=false;m.setAttribute('aria-hidden','false');setMenuPageLock(true)}m.classList.toggle('open',show);shade?.classList.toggle('show',show);btn?.setAttribute('aria-expanded',String(show));shade?.setAttribute('aria-hidden',String(!show));if(!show){const release=()=>{if(token!==MENU_CLOSE_TOKEN||m.classList.contains('open'))return;setMenuPageLock(false);m.inert=true;m.setAttribute('aria-hidden','true')};const onEnd=e=>{if(e.target===m&&e.propertyName==='transform'){m.removeEventListener('transitionend',onEnd);release()}};if(window.matchMedia('(prefers-reduced-motion:reduce)').matches)release();else{m.addEventListener('transitionend',onEnd);MENU_CLOSE_TIMER=setTimeout(()=>{m.removeEventListener('transitionend',onEnd);release()},340)}}}
const MOBILE_MENU_MQ=window.matchMedia('(max-width:900px)');
function syncMenuToViewport(){
  if(!MOBILE_MENU_MQ.matches){
    toggleSideMenu(false);
    const m=$('sideMenu');
    if(m)m.classList.remove('open')
  }
}
if(MOBILE_MENU_MQ.addEventListener)MOBILE_MENU_MQ.addEventListener('change',syncMenuToViewport);
else if(MOBILE_MENU_MQ.addListener)MOBILE_MENU_MQ.addListener(syncMenuToViewport);
window.addEventListener('resize',syncMenuToViewport);
function markSideActive(target){document.querySelectorAll('.sideNav button').forEach(b=>b.classList.toggle('active',b.dataset.target===target))}
function showPanel(id){const current=document.querySelector('.panelSection.activeSection');if(current?.id===id)return;document.querySelectorAll('.panelSection').forEach(el=>{const active=el.id===id;el.classList.toggle('activeSection',active);if(active){el.getAnimations?.().forEach(a=>a.cancel());void el.offsetWidth}});markSideActive(id);try{history.replaceState(null,'','#'+id)}catch{} const scroller=MOBILE_MENU_MQ.matches?window:document.querySelector('.workspace');scroller?.scrollTo?.({top:0,behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'})}
function goSection(id,btn){const el=$(id);if(!el)return;showPanel(id);if(id==='chatToolsSection')loadChatPlatforms();if(id==='workStatusSection')loadWorkStatus();if(id==='sessionResumeSection')loadSessionResume();if(id==='agentToolsSection')loadAgentTools();if(id==='agentSkillsSection')loadAgentSkills();if(id==='readableLogsSection')loadReadableLogs();if(id==='approvalSettingsSection')loadApprovalSettings();if(id==='settingsSection')loadAuthSettings();if(window.matchMedia('(max-width:900px)').matches)toggleSideMenu(false)}
function initPanelPage(){const wanted=(location.hash||'').replace('#','');const first=document.querySelector('.panelSection')?.id||'currentSection';const id=$(wanted)?wanted:first;showPanel(id);if(id==='chatToolsSection')loadChatPlatforms();if(id==='workStatusSection')loadWorkStatus();if(id==='sessionResumeSection')loadSessionResume();if(id==='agentToolsSection')loadAgentTools();if(id==='agentSkillsSection')loadAgentSkills();if(id==='readableLogsSection')loadReadableLogs();if(id==='approvalSettingsSection')loadApprovalSettings();if(id==='settingsSection')loadAuthSettings()}
requestAnimationFrame(()=>document.body.classList.add('ready'));
const MOTION_OBSERVER=new window.MutationObserver(records=>{const roots=new Set();for(const record of records){if(record.addedNodes.length&&record.target?.nodeType===1)roots.add(record.target)}for(const root of roots)animateRenderedItems(root)});
requestAnimationFrame(()=>{const app=$('app');if(app)MOTION_OBSERVER.observe(app,{childList:true,subtree:true})});
let TOAST_TIMER=null,TOAST_EXIT_TIMER=null,TOAST_TOKEN=0,TOAST_END_HANDLER=null;
function toast(msg){if(!msg||msg==='NEED_LOGIN'||/unauthorized/i.test(String(msg)))return;const t=$('toast');const token=++TOAST_TOKEN;clearTimeout(TOAST_TIMER);clearTimeout(TOAST_EXIT_TIMER);if(TOAST_END_HANDLER)t.removeEventListener('animationend',TOAST_END_HANDLER);t.textContent=msg;t.classList.remove('leaving','show');void t.offsetWidth;t.classList.add('show');TOAST_TIMER=setTimeout(()=>{if(token!==TOAST_TOKEN)return;t.classList.add('leaving');const done=()=>{if(token!==TOAST_TOKEN)return;t.classList.remove('show','leaving');TOAST_TIMER=null;TOAST_EXIT_TIMER=null};TOAST_END_HANDLER=e=>{if(e.target===t&&e.animationName==='toast-out')done()};if(window.matchMedia('(prefers-reduced-motion:reduce)').matches)done();else{t.addEventListener('animationend',TOAST_END_HANDLER);TOAST_EXIT_TIMER=setTimeout(done,280)}},3200)}
function nowTime(){return new Date().toLocaleTimeString('zh-CN',{hour12:false})}
function clearTestLog(){const box=$('testLogBody'); if(box) box.innerHTML='<div class="muted">日志已清空，等待开始检测...</div>'}
function setTestLogVisible(visible){const log=$('testLog'); const btn=$('testLogToggleBtn'); if(!log)return; log.classList.toggle('hidden', !visible); if(btn) btn.textContent=visible?'隐藏检测日志':'查看检测日志'}
function toggleTestLog(force){const log=$('testLog'); const visible=force===undefined?(log?.classList.contains('hidden')!==false):!!force; setTestLogVisible(visible)}
function appendTestLog(msg,type='run'){const box=$('testLogBody'); if(!box)return; const stick=box.scrollHeight-box.scrollTop-box.clientHeight<24; if(box.querySelector('.muted'))box.innerHTML=''; const row=document.createElement('div'); row.className='logLine '+type; row.innerHTML='<span class="logTime">'+esc(nowTime())+'</span><span>'+esc(msg)+'</span>'; box.appendChild(row); if(stick) box.scrollTop=box.scrollHeight}
function summarizeResult(r){if(!r)return '没有返回结果'; const status=(r.ok?'可用':'不可用/空回复')+' · HTTP '+(r.http_status??'-')+' · '+(r.latency_ms??'-')+'ms'; return (r.providerIndex||'-')+'号 '+(r.provider_name||'-')+' / '+(r.model||'-')+'：'+status+(r.ok?'':' · '+(r.error||'测试失败'))}
function resultLogType(r){return r&&r.ok?'ok':'bad'}
const REQUEST_LOCKS=new Set();
const REQUEST_SEQUENCE=Object.create(null);
const INFLIGHT_CONTROLLERS=new Set();
function nextRequestSequence(name){return REQUEST_SEQUENCE[name]=(REQUEST_SEQUENCE[name]||0)+1}
function isLatestRequest(name,seq){return REQUEST_SEQUENCE[name]===seq}
function isButtonElement(btn){return !!btn&&typeof btn.closest==='function'&&btn.dataset&&btn.classList}
function busyStart(btn,label='处理中…'){if(!isButtonElement(btn)||btn.closest('.sideNav')||btn.id==='mobileMenuBtn'||btn.id==='logoutBtn'||btn.dataset.apiBusy==='1')return false;btn.dataset.apiBusy='1';btn.dataset.busy='1';btn.dataset.idleText=btn.textContent;btn.disabled=true;btn.classList.add('loadingBtn');btn.textContent=label;return true}
function busyEnd(btn){if(!isButtonElement(btn))return;btn.disabled=btn.dataset.batchLocked==='1';btn.classList.remove('loadingBtn');btn.textContent=btn.dataset.idleText||btn.textContent;delete btn.dataset.apiBusy;delete btn.dataset.busy;delete btn.dataset.idleText}
function clearSensitiveClientState(){store.state=null;store.sessionStatusCache=[];store.sessionMeta={agents:[],agent:'',page:1,pageSize:20,total:0,pages:1,search:'',choices:[]};for(const id of ['providers','current','imageGenBox','chatToolsBox','workStatusBox','sessionResumeBox','agentToolsBox','agentSkillsBox','testResults','asrResult','ttsResult','serviceStatus']){const el=$(id);if(el)el.replaceChildren()}store.csrfToken=''}
function invalidateClientSession(){for(const controller of INFLIGHT_CONTROLLERS)controller.abort();INFLIGHT_CONTROLLERS.clear();for(const key of Object.keys(REQUEST_SEQUENCE))REQUEST_SEQUENCE[key]++;clearSensitiveClientState();showLogin()}
async function api(path,opts={}){
  const method=String(opts.method||'GET').toUpperCase();
  const isLong=method!=='GET'||/^\/(state|usage|service-status|chat-platforms|toolsets|skills|service-scopes|gateway-logs|sessions)/.test(path);
  const key=method+' '+path+' '+String(opts.body||'');
  if(isLong&&REQUEST_LOCKS.has(key))throw new Error('操作正在处理中');
  const btn=isLong?(opts.sourceButton||null):null;
  const ownsButton=btn?busyStart(btn):false;
  if(isLong)REQUEST_LOCKS.add(key);
  const controller=new AbortController();
  INFLIGHT_CONTROLLERS.add(controller);
  const timeout=Number(opts.timeout)||(/^\/(test|mimo\/)/.test(path)?190000:30000);
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const {timeout:ignored,sourceButton:ignoredButton,...fetchOpts}=opts;
    const headers={'Content-Type':'application/json',...(store.csrfToken&&method!=='GET'?{'X-CSRF-Token':store.csrfToken}:{}),...(fetchOpts.headers||{})};
    const r=await fetch(API_BASE+path,{credentials:'same-origin',...fetchOpts,headers,signal:controller.signal});
    const type=String(r.headers.get('content-type')||'').toLowerCase();
    if(!type.includes('application/json'))throw new Error('服务器返回了非 JSON 响应（HTTP '+r.status+'）');
    const j=await r.json();
    if(r.status===401){if(path!=='/login')invalidateClientSession();const e=new Error(path==='/login'?(j.error||'密码错误'):'NEED_LOGIN');e.code=path==='/login'?'LOGIN_FAILED':'NEED_LOGIN';throw e}
    if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));
    return j;
  }catch(e){if(e?.name==='AbortError')throw new Error('请求超时');throw e;
  }finally{
    clearTimeout(timer);
    INFLIGHT_CONTROLLERS.delete(controller);
    if(isLong)REQUEST_LOCKS.delete(key);
    if(ownsButton)busyEnd(btn);
  }
}
function showLogin(){ const app=$('app'); if(app) app.classList.add('hidden'); const login=$('login'); if(login) login.classList.remove('hidden') }
function showApp(){ $('login').classList.add('hidden'); const app=$('app'); app.classList.remove('hidden','entering'); void app.offsetWidth; app.classList.add('entering') }
async function login(sourceButton){
  const pw=$('password');
  const password=pw?String(pw.value||''):'';
  const feedback=$('loginFeedback');
  if(feedback){feedback.className='loginFeedback';feedback.textContent='正在验证密码…'}
  try{
    const result=await api('/login',{method:'POST',body:JSON.stringify({password}),sourceButton});
    store.csrfToken=String(result.csrf_token||'');
    if(feedback){feedback.className='loginFeedback success';feedback.textContent='登录成功，正在进入…'}
    applyAuthSettings(result);
    showApp();
    await loadState();
  }catch(e){if(feedback){feedback.className='loginFeedback error';feedback.textContent=e.message==='NEED_LOGIN'?'登录已失效，请重试':e.message}if(pw){pw.select();pw.focus()}}
}
function applyAuthSettings(s){
  if(s?.csrf_token)store.csrfToken=String(s.csrf_token);
  const on=!!(s&&s.password_enabled);
  const logoutBtn=$('logoutBtn'); if(logoutBtn) logoutBtn.classList.toggle('hidden',!on);
  const box=$('authEnabled'); if(box) box.checked=on;
  const hint=$('authHint');
  if(hint) hint.textContent=on?(s.password_set?'密码保护已打开':'密码保护已打开，但还没设密码'):'密码保护已关闭，谁打开这个网址都能进';
  const old=$('authOldPassword'); if(old) old.value='';
  const nw=$('authNewPassword'); if(nw) nw.value='';
}
async function loadAuthSettings(){
  try{applyAuthSettings(await api('/auth-settings'))}catch(e){const hint=$('authHint'); if(hint) hint.textContent=e.message}
}
async function saveAuthSettings(sourceButton){
  const btn=sourceButton||$('saveAuthBtn');
  if(btn){if(btn.dataset.busy)return; btn.dataset.busy='1'; btn.disabled=true}
  try{
    const enabled=!!$('authEnabled')?.checked;
    const old_password=String($('authOldPassword')?.value||'');
    const new_password=String($('authNewPassword')?.value||'');
    if(enabled&&!new_password)throw new Error('打开密码保护时必须输入至少 8 位的新密码');
    if(enabled&&new_password.length<8)throw new Error('新密码至少 8 位');
    if(new_password){
      const changed=await api('/change-password',{method:'POST',body:JSON.stringify({old_password,new_password})});applyAuthSettings(changed);
    }
    const s=await api('/auth-settings',{method:'POST',body:JSON.stringify({password_enabled:enabled,new_password:enabled?new_password:''})});
    applyAuthSettings(s);
    toast(enabled?'已打开密码保护':'已关闭密码保护');
  }catch(e){toast(e.message)}
  finally{if(btn){btn.dataset.busy=''; btn.disabled=false}}
}
async function loadApprovalSettings(){
  const hint=$('approvalHint');
  try{const agentSelect=$('approvalAgent');if(agentSelect&&!agentSelect.options.length){const agents=knownAgents();const states=await Promise.all(agents.map(async a=>{try{return await api(`/approval-settings?agent=${encodeURIComponent(a.id)}`)}catch{return {agent:a.id,mode:'manual'}}}));const saved=window.localStorage.getItem('hermes-approval-agent');agentSelect.innerHTML=agents.map(a=>{const state=states.find(x=>x.agent===a.id);const mode=state?.mode||'manual';const tag=mode==='off'?'无需同意':mode==='smart'?'智能批准':'始终询问';return `<option value="${escAttr(a.id)}">${esc(a.profile||a.id)} · ${tag}</option>`}).join('');const preferred=agents.some(a=>a.id===saved)?saved:(states.find(x=>x.mode!=='manual')?.agent||agents[0]?.id);if(preferred)agentSelect.value=preferred}const agent=agentSelect?.value||'default';window.localStorage.setItem('hermes-approval-agent',agent);const s=await api(`/approval-settings?agent=${encodeURIComponent(agent)}`);const select=$('approvalMode');if(select)select.value=s.mode||'manual';if(hint)hint.textContent=s.mode==='off'?'当前 Agent 不发送危险命令批准请求。':s.mode==='smart'?'当前 Agent：低风险自动批准，高风险命令仍会请求同意。':'当前 Agent 的危险命令会发送批准请求。'}catch(e){if(hint)hint.textContent=e.message}
}
async function saveApprovalSettings(sourceButton){
  const mode=String($('approvalMode')?.value||'manual');
  const agent=String($('approvalAgent')?.value||'default');
  if(mode==='off'&&!await askConfirm('关闭命令批准后，Hermes 将不再询问便会执行被判定为危险的命令。确定继续？'))return;
  try{const s=await api('/approval-settings',{method:'POST',body:JSON.stringify({agent,mode}),sourceButton});await loadApprovalSettings();toast(s.restart_required?'已保存当前 Agent；重启对应 Gateway 后生效':'已保存')}catch(e){toast(e.message)}
}
async function logout(){if(!await askConfirm('确定退出模型台？'))return;try{const result=await api('/logout',{method:'POST',body:'{}'});applyAuthSettings(result);if(result.logged_out){clearSensitiveClientState();showLogin();toast('已退出')}else{toast('密码保护未开启，无需退出登录')}}catch(e){toast(e.message)}}
async function logoutAll(sourceButton){if(!await askConfirm('确定让全部设备的登录立即失效？'))return;try{const result=await api('/logout-all',{method:'POST',body:'{}',sourceButton});if(result.password_enabled){invalidateClientSession();return}store.csrfToken=String(result.csrf_token||'');toast('全部旧设备会话已退出，本机无需密码可继续使用')}catch(e){toast(e.message)}}

function imageModelsFor(agentId, current){
  const live=window.IMAGE_MODELS&&window.IMAGE_MODELS[agentId];
  const list=(live&&live.length?live:(store.state.image_models||[])).slice();
  if(current&&!list.includes(current)) list.unshift(current);
  if(!list.length) list.push('gpt-image-2','gpt-image-2-medium','gpt-image-1.5','gpt-image-1');
  return Array.from(new Set(list.filter(Boolean)));
}
function imageAgentCard(a){
  const ig=a.image_gen||{};
  const cur=a.current||{};
  const current=ig.model||ig.openai_model||'';
  const models=imageModelsFor(a.id,current);
  const hint=(window.IMAGE_MODEL_HINT&&window.IMAGE_MODEL_HINT[a.id])||'';
  const opts=models.map(m=>`<option value="${escAttr(m)}" ${m===current?'selected':''}>${esc(m)}</option>`).join('');
  const relay=cur.provider_name||cur.provider||ig.provider||'-';
  const url=cur.base_url||ig.base_url||'-';
  return `<div class="agentCard imageAgentCard"><div class="agentTop"><div class="agentName">${esc(a.profile||a.id)}</div><div class="agentProfile">生图</div></div><div class="agentLine"><div class="label">生图</div><div class="value">${esc(current||'-')}</div></div><div class="agentLine"><div class="label">中转</div><div class="value">${esc(relay)} · ${esc(url)}</div></div><select id="image_model_${escAttr(a.id)}">${opts}</select><div class="imgActions"><button type="button" class="ghostSm" data-action="fetch-image-models" data-agent="${escAttr(a.id)}">获取</button><button class="primary" data-action="switch-image-gen" data-agent="${escAttr(a.id)}">切换</button></div>${hint?`<div class="muted">${esc(hint)}</div>`:''}</div>`;
}
function renderImageGen(){
  const box=$('imageGenBox');if(!box)return;
  const agents=store.state.agents&&store.state.agents.length?store.state.agents:[];
  const union=Array.from(new Set(agents.flatMap(a=>imageModelsFor(a.id,a.image_gen&&(a.image_gen.model||a.image_gen.openai_model)))));
  box.innerHTML=`<div class="current">${agents.map(imageAgentCard).join('')}</div><div class="actions"><button type="button" data-action="fetch-image-models" data-agent="all">全部获取对应中转</button><select id="imageModelAll">${union.map(m=>`<option value="${escAttr(m)}">${esc(m)}</option>`).join('')}</select><button class="primary" data-action="switch-image-gen" data-agent="all">全部都切</button></div>`;
}
async function fetchImageModels(agent){
  const ids=agent==='all'?knownAgents().map(a=>a.id):[agent];
  window.IMAGE_MODELS=window.IMAGE_MODELS||{};
  window.IMAGE_MODEL_HINT=window.IMAGE_MODEL_HINT||{};
  for(const id of ids){
    window.IMAGE_MODEL_HINT[id]='正在从对应中转获取…';
    renderImageGen();
    try{
      const r=await api('/image-gen/models',{method:'POST',body:JSON.stringify({agent:id})});
      window.IMAGE_MODELS[id]=r.models||[];
      const n=(r.models||[]).length;
      window.IMAGE_MODEL_HINT[id]=r.fallback
        ?`中转 ${r.relay?.name||''} 拉列表失败，已用本地已有 ${n} 个${r.error?('：'+r.error):''}`
        :`已从 ${r.relay?.name||'中转'} 获取 ${n} 个生图模型`;
    }catch(e){
      window.IMAGE_MODEL_HINT[id]='获取失败：'+e.message;
    }
    renderImageGen();
  }
}
async function switchImageGen(agent){const model=agent==='all'?$('imageModelAll').value:$('image_model_'+agent).value;if(!await askConfirm('确定把 '+agentLabel(agent)+' 的生图模型切换到 '+model+'？\\n将写入该 agent 配置，中转按它当前正在用的那家。'))return;try{const r=await api('/image-gen/switch',{method:'POST',body:JSON.stringify({agent,model})});store.state=r.state;renderImageGen();toast('已切换生图模型：'+agentLabel(agent)+' / '+model)}catch(e){toast(e.message)}}
function renderCurrent(c){
  const agents=store.state.agents&&store.state.agents.length?store.state.agents:[{id:'default',name:'Agent1',profile:'agent1',current:c||{}}];
  const stMap=store.agentStatus||{};
  $('current').innerHTML=agents.map(a=>{const x=a.current||{};const label=a.profile||a.id;const key=String(a.profile||a.id||'');const st=stMap[key]||stMap[a.id]||'';const on=/^(active|ok|running|up)$/i.test(String(st).trim());const canDel=a.id!=='default'&&a.profile!=='agent1';return `<div class="agentCard"><div class="agentTop"><div class="agentName"><span class="dot ${on?'on':(st?'off':'')}"></span>${esc(label)}</div>${st?`<div class="agentProfile">${esc(st)}</div>`:''}</div><button class="agentTestBtn" type="button" data-action="test-agent-current" data-agent="${escAttr(a.id||'default')}">测试当前可用</button><div class="agentModel">${esc(x.model||'-')}</div><div class="agentMeta"><div class="agentLine"><div class="label">中转</div><div class="value">${esc(x.provider_name||x.provider||'-')}</div></div><div class="agentLine"><div class="label">地址</div><div class="value">${esc(x.base_url||'-')}</div></div></div>${canDel?`<div class="actions"><button type="button" class="danger small" data-action="delete-agent" data-agent="${escAttr(a.id)}" data-label="${escAttr(label)}">删除这个 agent</button></div>`:''}<div class="agentInlineResult" id="agent_test_${escAttr(a.id||'default')}"></div>${a.error?`<div class="err">${esc(a.error)}</div>`:''}</div>`}).join('');
  fillCloneFrom();
}
function fillCloneFrom(){
  const sel=$('cloneFromAgent'); if(!sel) return;
  const cur=sel.value;
  sel.innerHTML='<option value="">空白新建</option>'+knownAgents().map(a=>`<option value="${escAttr(a.id)}">克隆 ${esc(a.profile||a.id)} 的模型配置</option>`).join('');
  if([...sel.options].some(o=>o.value===cur)) sel.value=cur;
}
let USAGE_LOADED=false;
function fmtNum(n){return Number(n||0).toLocaleString('zh-CN')}
function hasMoney(b){return Number(b?.actual_cost||0)>0 || Number(b?.estimated_cost||0)>0}
function fmtMoney(n){return '$'+Number(n||0).toFixed(4)}
function moneyLine(b){return hasMoney(b)?`费用：预估 ${fmtMoney(b.estimated_cost)} / 实际 ${fmtMoney(b.actual_cost)}`:'费用未记录：当前自定义中转站没有 Hermes 价格表或实际扣费回传'}
function usageBox(label, b){return `<div class="usageMini"><div class="k">${label}</div><div class="num">${fmtNum(b.total_tokens)}</div><div class="sub">输入 ${fmtNum(b.input_tokens)} / 输出 ${fmtNum(b.output_tokens)} · 调用 ${fmtNum(b.api_calls)}</div><div class="sub">会话 ${fmtNum(b.sessions)} · ${moneyLine(b)}</div></div>`}
function shortUrl(u){try{const x=new URL(u);return x.host+x.pathname.replace(/\/$/,'')}catch{return u||''}}
async function toggleUsage(){
  const box=$('usage'); const btn=$('usageToggleBtn'); if(!box) return;
  if(!box.classList.contains('hidden')){box.classList.add('hidden'); if(btn) btn.textContent='查看 API 使用量'; $('usageSource').textContent=USAGE_LOADED?'已隐藏':'点击按钮查看'; return;}
  box.classList.remove('hidden'); if(btn){btn.classList.toggle('loadingBtn',!USAGE_LOADED);btn.textContent=USAGE_LOADED?'隐藏 API 使用量':'正在读取';}
  if(!USAGE_LOADED) await loadUsage();
  if(btn){btn.classList.remove('loadingBtn');btn.textContent='隐藏 API 使用量';}
}
async function loadUsage(){
  const box=$('usage'); if(!box) return;
  box.innerHTML='<div class="muted">正在读取 Hermes 对话 token 用量...</div>';
  try{
    const u=await api('/usage');
    if(!u.ok) throw new Error(u.error||'使用量读取失败');
    USAGE_LOADED=true;
    const moneyNote=hasMoney(u.total)?'已记录费用':'费用未记录';
    $('usageSource').textContent='Hermes 对话 · '+moneyNote+' · '+(u.total.last_at_iso||'暂无记录');
    const providers=(u.by_provider||[]).map(p=>`<div class="usageModelRow"><div><b>${esc(p.provider||'-')}</b><div class="sub">${esc(shortUrl(p.base_url))}</div><div class="sub">调用 ${fmtNum(p.api_calls)} · 输入 ${fmtNum(p.input_tokens)} / 输出 ${fmtNum(p.output_tokens)}</div><div class="sub">${moneyLine(p)}</div></div><div class="v">${fmtNum(p.total_tokens)}</div></div>`).join('') || '<div class="muted">暂无中转站统计</div>';
    const models=(u.by_model||[]).map(m=>`<div class="usageModelRow"><div><b>${esc(m.model||'-')}</b><div class="sub">${esc(m.provider||'-')} · ${esc(shortUrl(m.base_url))}</div><div class="sub">调用 ${fmtNum(m.api_calls)} · 输入 ${fmtNum(m.input_tokens)} / 输出 ${fmtNum(m.output_tokens)}</div><div class="sub">${moneyLine(m)}</div></div><div class="v">${fmtNum(m.total_tokens)}</div></div>`).join('') || '<div class="muted">暂无模型统计</div>';
    box.innerHTML=usageBox('最近 24 小时',u.last_24h||{})+usageBox('最近 7 天',u.last_7d||{})+usageBox('累计全部',u.total||{})+`<div class="usageModels"><div class="k">最近 7 天按中转站</div>${providers}</div><div class="usageModels"><div class="k">最近 7 天按模型</div>${models}</div>`;
  }catch(e){
    $('usageSource').textContent='读取失败';
    box.innerHTML='<div class="err">'+esc(e.message)+'</div>';
  }
}

function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function apiModeLabel(mode){const m=String(mode||'');return {chat_completions:'OpenAI API',responses:'OpenAI Responses',codex_responses:'Codex Responses',anthropic_messages:'Claude API'}[m]||m}
function resultId(providerIndex, model){return 'model_result_'+providerIndex+'_'+btoa(unescape(encodeURIComponent(model))).replace(/[^a-zA-Z0-9]/g,'_')}
function hasMimoAudio(p){const ms=(p.models||[]).map(x=>String(x).toLowerCase());return ms.some(m=>m.includes('mimo')&&(m.includes('asr')||m.includes('tts')))}
function openMimoAudio(providerIndex){openModal('mimoModal','asrFile');toast('打开小米语音工具')}
function closeMimoAudio(){closeModal('mimoModal')}
function isActiveForAgent(agentId,p,m){const a=(store.state.agents||[]).find(x=>x.id===agentId);const c=a?.current||{};const ps=String(p.slug||'');const cs=String(c.provider_slug||c.provider||'');if(cs&&cs!=='custom'&&ps&&cs===ps)return c.model===m;return c.base_url===p.base_url&&c.model===m&&(!c.provider_slug||c.provider_slug==='custom')}
function knownAgents(){return (store.state&&store.state.agents&&store.state.agents.length)?store.state.agents:[]}
function agentLabel(id){if(id==='all'||id==='both')return '全部 Agent';const a=knownAgents().find(x=>x.id===id||x.profile===id);return a?(a.profile||a.id):(id==='default'?'agent1':id)}
function renderModelItem(p,m){
  const agents=knownAgents();
  const using=agents.filter(a=>isActiveForAgent(a.id,p,m));
  const any=using.length>0;
  const usingText=using.map(a=>`${esc(a.profile||a.id)} 正在用`).join(' ');
  const switchBtns=agents.map(a=>`<button data-action="switch-model" data-provider="${p.id}" data-model="${escAttr(m)}" data-agent="${escAttr(a.id)}">切 ${esc(a.profile||a.id)}</button>`).join('');
  const allBtn=agents.length>1?`<button data-action="switch-model" data-provider="${p.id}" data-model="${escAttr(m)}" data-agent="all">全部都切</button>`:'';
  return `<div class="modelItem ${any?'active':''}"><button class="deleteModelBtn" title="删除模型" data-action="delete-model" data-provider="${escAttr(p.id)}" data-model="${escAttr(m)}">×</button><div class="modelName">${esc(m)}</div><div class="sub">${usingText}</div><div class="modelBtns"><button class="testBtn" data-action="test-model" data-provider="${escAttr(p.id)}" data-model="${escAttr(m)}">测试</button>${switchBtns}${allBtn}</div><div class="modelResult" id="${escAttr(resultId(p.id,m))}"></div></div>`
}
function renderTestTargets(ps){
  const keep=$('testTarget').value;
  const opts=knownAgents().map(a=>`<option value="agent:${escAttr(a.id)}">${esc(a.profile||a.id)} 当前可用</option>`);
  opts.push('<option value="current">当前使用</option>','<option value="all">测试全部中转站（每站默认模型）</option>');
  (ps||[]).forEach(p=>{
    opts.push(`<option value="provider-all:${p.id}">${p.id}号 ${esc(p.name)} / 一键测试这个中转全部模型（${(p.models||[]).length} 个）</option>`);
    (p.models||[]).forEach(m=>{opts.push(`<option value="p:${p.id}:${encodeURIComponent(m)}">${p.id}号 ${esc(p.name)} / ${esc(m)}</option>`)});
  });
  $('testTarget').innerHTML=opts.join('');
  if([...$('testTarget').options].some(o=>o.value===keep)) $('testTarget').value=keep;
}
function renderRestartOptions(){
  const sel=$('restartAgent'); if(!sel)return;
  const keep=sel.value;
  const opts=knownAgents().map(a=>`<option value="${escAttr(a.id)}">重启 ${esc(a.profile||a.id)}</option>`);
  if(knownAgents().length>1) opts.push('<option value="all">全部重启</option>');
  sel.innerHTML=opts.join('');
  if([...sel.options].some(o=>o.value===keep)) sel.value=keep;
  const pairing=$('pairingAgent');
  if(pairing){const old=pairing.value;pairing.innerHTML=knownAgents().map(a=>`<option value="${escAttr(a.id)}">${esc(a.profile||a.id)}</option>`).join('');if([...pairing.options].some(o=>o.value===old))pairing.value=old;syncPairingScope()}
}
function toggleProviderModels(id){if(store.expandedProviders.has(id)) store.expandedProviders.delete(id); else store.expandedProviders.add(id); renderProviders(store.state.providers)}
function providerText(p){return [p.id,p.name,p.base_url,p.api_mode,p.slug,p.api_key_redacted,...(p.models||[])].join(' ').toLowerCase()}
function filteredProviders(ps){const q=(store.providerSearch||'').trim().toLowerCase();return q?(ps||[]).filter(p=>providerText(p).includes(q)):(ps||[])}
function providerPageCount(list){return Math.max(1,Math.ceil((list||[]).length/PROVIDER_PAGE_SIZE))}
function providerSearchChanged(){store.providerSearch=$('providerSearch')?.value||'';store.providerPage=1;renderProviders(store.state.providers)}
function gotoProviderPage(page){const list=filteredProviders(store.state.providers||[]);const max=providerPageCount(list);store.providerPage=Math.min(max,Math.max(1,Number(page)||1));renderProviders(store.state.providers)}
function jumpProvider(id){if(!id)return;const all=filteredProviders(store.state.providers||[]);const idx=all.findIndex(p=>String(p.id)===String(id));if(idx>=0){store.providerPage=Math.floor(idx/PROVIDER_PAGE_SIZE)+1;store.expandedProviders.add(Number(id));renderProviders(store.state.providers);setTimeout(()=>document.getElementById('provider_'+id)?.scrollIntoView({behavior:'smooth',block:'start'}),80)}}
function renderProviderControls(all, list, shown){const max=providerPageCount(list);if(store.providerPage>max)store.providerPage=max;const input=$('providerPageInput');if(input){input.max=max;input.value=store.providerPage}const info=$('providerPageInfo');if(info)info.textContent=`第 ${store.providerPage} / ${max} 页 · 每页 ${PROVIDER_PAGE_SIZE} 个`;const summary=$('providerSummary');if(summary){const modelCount=list.reduce((n,p)=>n+(p.models||[]).length,0);summary.textContent=`共 ${all.length} 个中转站，当前匹配 ${list.length} 个 / ${modelCount} 个模型；本页显示 ${shown.length} 个。`}const jump=$('providerJump');if(jump){const keep=jump.value;const opts=['<option value="">一键到达中转站...</option>'];list.forEach(p=>opts.push(`<option value="${escAttr(p.id)}">${p.id}号：${esc(p.name)}（${(p.models||[]).length} 模型）</option>`));jump.innerHTML=opts.join('');if([...jump.options].some(o=>o.value===keep))jump.value=keep;}}
function renderProviderCard(p){const all=p.models||[];const expanded=store.expandedProviders.has(p.id);const shown=expanded?all:all.slice(0,2);const more=all.length>2;const safeId=escAttr(p.id);const dp=`data-provider="${safeId}"`;return `<div class="provider" id="provider_${safeId}"><div class="phead"><div><div class="pname">${esc(p.id)}号：${esc(p.name)}</div><div class="pmeta">${esc(p.base_url)} · ${esc(apiModeLabel(p.api_mode))} · key ${esc(p.api_key_redacted)}</div><div class="pmeta">${esc(p.slug)}</div>${more&&!expanded?`<div class="modelCount">已折叠：显示 2 / ${all.length} 个模型</div>`:''}</div><div class="actions"><button class="small" type="button" id="refreshModels_${safeId}" data-action="refresh-provider" ${dp}>重新获取模型</button><button class="small primary" data-action="test-provider-all" ${dp}>一键测试全部模型</button><button class="small danger" data-action="delete-provider" ${dp}>删除</button></div></div>${hasMimoAudio(p)?`<button class="mimoAudioBtn" data-action="open-mimo" ${dp}>小米 MiMo 语音 ASR / TTS</button>`:''}<div class="modelList">${shown.map(m=>renderModelItem(p,m)).join('')}</div>${more?`<button class="modelCollapse" data-action="toggle-provider" ${dp}>${expanded?'收起':'展开全部 '+all.length+' 个模型'}</button>`:''}<div class="actions"><input id="model_${safeId}" placeholder="添加模型名"><button class="small" data-action="add-model" ${dp}>添加模型</button></div></div>`}
function renderProviders(ps){const all=ps||[];const list=filteredProviders(all);const max=providerPageCount(list);if(store.providerPage>max)store.providerPage=max;const start=(store.providerPage-1)*PROVIDER_PAGE_SIZE;const shown=list.slice(start,start+PROVIDER_PAGE_SIZE);renderProviderControls(all,list,shown);$('providers').innerHTML=shown.map(renderProviderCard).join('')||(store.providerSearch?emptyState('没有匹配结果','尝试更换关键词'):emptyState('暂无中转站','先添加一个 API 中转站'))}
function escAttr(s){return esc(s).replace(/[\r\n]/g,'')}
function renderStatusChip(name,status,{connected,label}={}){const raw=String(status||'').trim().toLowerCase();const on=connected??/^(active|ok|running|up|connected)$/.test(raw);const text=label??({active:'运行中',ok:'正常',running:'运行中',up:'运行中',inactive:'未运行',failed:'异常',unknown:'状态未知',connected:'已连接'})[raw]??status??'状态未知';return `<span class="statusChip"><span class="dot ${on?'on':'off'}"></span><span class="name">${esc(name)}</span><span class="st">${esc(text)}</span></span>`}
function renderTopStatus(list,fallback='unknown'){const rows=Array.isArray(list)?list:[];if(!rows.length)return renderStatusChip('Gateway',fallback);const healthy=rows.filter(x=>/^(active|ok|running|up|connected)$/i.test(String(x.status||''))||x.ok===true).length;const abnormal=rows.length-healthy;const label=abnormal?`${healthy} 正常 · ${abnormal} 异常`:`${healthy} 个 Agent 运行中`;const detail=rows.map(x=>`${x.profile||x.agent||'Agent'}：${x.status||'unknown'}`).join('\n');return `<span class="statusSummary" title="${escAttr(detail)}"><span class="dot ${abnormal?'off':'on'}"></span><span>${esc(label)}</span></span>`}
function renderFoldCard({open,action,key,title,hint,count,body='',countLabel=''}){const badge=countLabel||`${count} 项`;return `<div class="sessAgent ${open?'open':''}"><button type="button" class="sessFoldHead" data-action="${escAttr(action)}" data-key="${escAttr(key)}" aria-expanded="${open?'true':'false'}"><span class="sessChevron" aria-hidden="true">›</span><span class="sessFoldMain"><span class="workName">${esc(title)}</span><span class="sessFoldHint">${esc(hint)}</span></span><span class="sessCount">${esc(badge)}</span></button>${body}</div>`}
function openCommandsPage(){openModal('commandsModal')}
function closeCommandsPage(){closeModal('commandsModal')}
function renderCommands(cs){const box=$('commands'); if(!box)return; box.innerHTML=cs.map(c=>`<div class="cmd"><div><code>/${esc(c.name)}</code><div class="muted">${esc(c.description)}</div></div><div class="muted">${esc(c.target)}</div></div>`).join('')||'<p class="muted">暂无快捷命令</p>'}
let CHAT_PLATFORMS=null;
const OPEN_PLATS=new Set();
function platKey(agent,plat){return agent+'::'+plat}
function fieldInput(agent,plat,f){
  const id=`pf_${agent}_${plat}_${f.key}`;
  const ph=f.set?(f.secret?(f.preview||'已保存，留空不改'):(f.preview||'已保存，可改')):(f.placeholder||'');
  return `<label class="k" for="${id}">${esc(f.label)}${f.required?' *':''}</label><input id="${id}" ${f.secret?'type="password" autocomplete="new-password"':''} placeholder="${esc(ph)}" data-key="${esc(f.key)}">`;
}
function togglePlatForm(agent,plat){
  const k=platKey(agent,plat);
  if(OPEN_PLATS.has(k)) OPEN_PLATS.delete(k); else {OPEN_PLATS.clear(); OPEN_PLATS.add(k)}
  renderChatPlatforms(CHAT_PLATFORMS);
}
function renderChatPlatforms(data){
  const box=$('chatToolsBox'); if(!box)return;
  const agents=data&&data.agents||[];
  if(!agents.length){box.innerHTML='<p class="muted">没有扫到 agent</p>';return}
  box.innerHTML=agents.map((a,idx)=>{
    const plats=a.platforms||[];
    const configured=plats.filter(p=>p.configured);
    const connected=plats.filter(p=>p.state==='connected');
    const errored=plats.filter(p=>['error','failed'].includes(String(p.state||'').toLowerCase()));
    const on=configured.map(p=>p.label).join('、')||'暂未配置';
    const chips=plats.map(p=>{
      const open=OPEN_PLATS.has(platKey(a.id,p.id));
      const state=String(p.state||'').toLowerCase();
      const stateClass=state==='connected'?'connected':(['error','failed'].includes(state)?'failed':state==='connecting'?'connecting':'');
      const stateText=p.configured?(state?platStateLabel(state):'待重启'):'未配置';
      return `<button type="button" class="platformChip ${p.configured?'on':'off'} ${stateClass}${open?' active':''}" data-action="toggle-platform" data-agent="${escAttr(a.id)}" data-platform="${escAttr(p.id)}" aria-expanded="${open?'true':'false'}"><span class="platformDot" aria-hidden="true"></span><span class="platformName">${esc(p.label)}</span><span class="platformState">${esc(stateText)}</span><span class="platformChevron" aria-hidden="true">›</span></button>`;
    }).join('');
    const openPlat=plats.find(p=>OPEN_PLATS.has(platKey(a.id,p.id)));
    let form='';
    if(openPlat){
      const fields=(openPlat.fields||[]).map(f=>fieldInput(a.id,openPlat.id,f)).join('');
      form=`<div class="platformForm"><div class="phead"><div><div class="pname">${esc(a.profile||a.id)} / ${esc(openPlat.label)}</div><div class="pmeta">${openPlat.configured?'密钥不会再次显示；留空表示不修改现有字段。':'填写必填项后添加这个平台。'}</div></div><button class="small" type="button" data-action="toggle-platform" data-agent="${escAttr(a.id)}" data-platform="${escAttr(openPlat.id)}">收起</button></div><div class="form" id="platForm_${escAttr(a.id)}_${escAttr(openPlat.id)}">${fields}</div><div class="platformFormActions">${openPlat.configured?`<button class="danger" type="button" data-action="disable-platform" data-agent="${escAttr(a.id)}" data-platform="${escAttr(openPlat.id)}" data-label="${escAttr(openPlat.label)}">关掉平台</button>`:''}<button class="primary" type="button" data-action="save-platform" data-agent="${escAttr(a.id)}" data-platform="${escAttr(openPlat.id)}">保存平台设置</button></div></div>`;
    }
    return `<div class="provider platformAgent${openPlat?' editing':''}"><div class="platformAgentHead"><div><div class="pname">${esc(a.profile||a.id)}</div><div class="pmeta">${esc(on)}</div></div><div class="platformStats"><span><b>${configured.length}</b><small>已配置</small></span><span class="good"><b>${connected.length}</b><small>已连接</small></span>${errored.length?`<span class="bad"><b>${errored.length}</b><small>异常</small></span>`:''}</div></div><div class="platToolGrid">${chips}</div>${form}</div>`;
  }).join('');
}
async function loadChatPlatforms(){
  const seq=nextRequestSequence('chat');
  const box=$('chatToolsBox');
  if(box){
    box.dataset.loading='1';
    if(!box.dataset.loaded) box.innerHTML='<div class="inlineLoader skeleton" role="status" aria-label="正在读取平台状态"></div>';
  }
  try{
    const r=await api('/chat-platforms');if(!isLatestRequest('chat',seq))return;
    CHAT_PLATFORMS=r;
    if(box){ box.dataset.loaded='1'; box.dataset.loading=''; }
    renderChatPlatforms(r);
  }catch(e){
    if(box){ box.dataset.loading=''; box.innerHTML='<p class="err">'+esc(e.message)+'</p>'; }
  }
}
async function saveChatPlatform(agent,platform,btn){
  const form=document.getElementById('platForm_'+agent+'_'+platform);
  if(!form)return;
  if(btn?.dataset.busy==='1')return;
  const values={};
  form.querySelectorAll('input[data-key]').forEach(el=>{
    const v=String(el.value||'').trim();
    if(v) values[el.dataset.key]=v;
  });
  try{
    if(btn){btn.dataset.busy='1';btn.disabled=true;btn.textContent='保存中…'}
    await api('/chat-platforms',{method:'POST',body:JSON.stringify({agent,platform,values}),sourceButton:btn});
    toast('已保存 '+platform+' · '+agentLabel(agent)+'，重启 Gateway 后进线');
    await loadChatPlatforms();
  }catch(e){toast(e.message)}
  finally{if(btn){btn.dataset.busy='';btn.disabled=false;btn.textContent='保存'}}
}
async function disableChatPlatform(agent,platform,label){
  if(!await askConfirm('确定关掉 '+agentLabel(agent)+' 的 '+(label||platform)+'？会清掉这个平台的 Token，重启 Gateway 后才掉线。'))return;
  try{
    await api('/chat-platforms/'+encodeURIComponent(agent)+'/'+encodeURIComponent(platform),{method:'DELETE'});
    OPEN_PLATS.delete(platKey(agent,platform));
    toast('已关掉 '+(label||platform)+' · '+agentLabel(agent)+'，重启 Gateway 后掉线');
    await loadChatPlatforms();
  }catch(e){toast(e.message)}
}
function platStateLabel(st){
  const s=String(st||'').toLowerCase();
  if(s==='connected') return '已连接';
  if(s==='connecting') return '连接中';
  if(s==='disconnected'||s==='stopped') return '未连接';
  if(s==='error'||s==='failed') return '出错';
  return st||'未知';
}
function renderWorkStatus(list){
  const box=$('workStatusBox'); if(!box)return;
  const rows=list||[];
  if(!rows.length){box.innerHTML='<p class="muted">没有扫到 agent</p>';return}
  const busyN=rows.filter(x=>x.ok && Number(x.active_agents)>0).length;
  const idleN=rows.filter(x=>x.ok && !(Number(x.active_agents)>0)).length;
  const downN=rows.filter(x=>!x.ok).length;
  const summary=`<div class="workCard"><div class="workHead"><div class="workName">一眼看</div><div class="workPlats">
    <span class="workFlag busy">干活 ${busyN}</span>
    <span class="workFlag idle">空闲 ${idleN}</span>
    <span class="workFlag down">停了 ${downN}</span>
  </div></div></div>`;
  box.innerHTML=summary+rows.map(x=>{
    const running=!!x.ok;
    const jobs=Number(x.active_agents)||0;
    const mode=!running?'down':(jobs>0?'busy':'idle');
    const flag=!running?'停了':(jobs>0?('正在干活 · '+jobs+' 个任务'):'空闲');
    const plats=Object.entries(x.platforms||{});
    const platHtml=plats.length?plats.map(([name,info])=>{
      const on=String(info.state||'')==='connected';
      const err=info.error_message?(' · '+info.error_message):'';
      return renderStatusChip(name,info.state,{connected:on,label:platStateLabel(info.state)+err});
    }).join(''):'<span class="muted">还没有平台状态</span>';
    const updated=x.updated_at?String(x.updated_at).replace('T',' ').replace(/\.\d+.*/,''):'';
    const who=(x.busy_targets||[]).map(t=>{
      const whoName=t.name?(' · '+t.name):'';
      const age=t.elapsed_label?(' · 已 '+t.elapsed_label):'';
      return esc((t.platform_label||t.platform||'平台')+whoName+age);
    }).join('；');
    const whoHtml=mode==='busy'?(who?`<div class="workWho">正在回：${who}</div>`:`<div class="workWho">正在干活，对方还不明确</div>`):'';
    return `<div class="workCard ${mode}"><div class="workHead"><div class="workName">${esc(x.profile||x.agent)}</div><span class="workFlag ${mode}">${esc(flag)}</span></div><div class="workMeta">Gateway ${esc(x.status||'unknown')}${x.gateway_state?' · '+esc(x.gateway_state):''}${updated?(' · '+esc(updated)):''}</div>${whoHtml}<div class="workPlats">${platHtml}</div><div class="actions">${['start','stop','restart'].map(action=>`<button class="small" type="button" ${(action==='start'&&running)||(action==='stop'&&!running)?'disabled':''} data-action="gateway-control" data-agent="${escAttr(x.agent)}" data-control="${action}">${{start:'启动',stop:'停止',restart:'重启'}[action]}</button>`).join('')}</div></div>`;
  }).join('');
}
async function loadWorkStatus(){
  const seq=nextRequestSequence('agents');
  const box=$('workStatusBox');
  if(box && !box.dataset.loaded) box.innerHTML='<div class="inlineLoader skeleton" role="status" aria-label="正在读取数据"></div>';
  try{
    const s=await api('/service-status');if(!isLatestRequest('agents',seq))return;
    if(box) box.dataset.loaded='1';
    renderWorkStatus(s.statuses||[]);
    store.agentStatus={};
    (s.statuses||[]).forEach(x=>{store.agentStatus[x.profile||x.agent]=x.status});
    const top=$('serviceStatus');
    if(top){
      const list=s.statuses||[];
      top.innerHTML=renderTopStatus(list,s.status);
    }
  }catch(e){if(!isLatestRequest('agents',seq))return;if(box) box.innerHTML='<p class="err">'+esc(e.message)+'</p>'}
}
function renderSessionResume(){
  const box=$('sessionResumeBox'); if(!box)return;
  const rows=store.sessionStatusCache||[], choices=store.sessionMeta.choices||[];
  if(!rows.length){box.innerHTML='<div class="emptyState"><b>没有匹配的上下文</b><span>换个关键词，或选择其他 Agent。</span></div>';renderSessionPager();return}
  box.innerHTML=`<div class="workSess">${rows.map(s=>{
    const who=[s.platform_label||s.platform,s.name].filter(Boolean).join(' · ');
    const tag=s.current?'当前':(s.open?'未结束':'已结束');
    const modelOpts=['<option value="">选择下一条使用的模型</option>'].concat(choices.map(m=>`<option value="${escAttr(m)}">${esc(m)}</option>`)).join('');
    return `<div class="workSessItem ${s.current?'cur':''}"><div class="workSessTop"><b>${esc(s.title||who||s.id)}</b><span class="sessTag ${s.current?'cur':''}">${esc(tag)}</span></div><div class="workSessMeta">${esc(who||'未知来源')}${s.when?(' · '+esc(s.when)):''}${s.model?(' · '+esc(s.model)):''}${s.message_count?(' · '+s.message_count+' 条消息'):''}</div><div class="workSessActs"><button class="small" type="button" ${s.current?'disabled':''} data-action="resume-session" data-agent="${escAttr(store.sessionMeta.agent)}" data-session="${escAttr(s.id)}">切回这条</button><select aria-label="选择这条上下文下一次使用的模型" data-action="session-model" data-agent="${escAttr(store.sessionMeta.agent)}" data-session-key="${escAttr(s.session_key)}">${modelOpts}</select><button class="small danger" type="button" data-action="delete-session" data-agent="${escAttr(store.sessionMeta.agent)}" data-session="${escAttr(s.id)}">删除</button></div></div>`;
  }).join('')}</div>`;
  renderSessionPager();
}
function renderSessionPager(){
  const p=$('sessionPager');if(!p)return;const m=store.sessionMeta;
  const start=m.total?((m.page-1)*m.pageSize+1):0,end=Math.min(m.total,m.page*m.pageSize);
  p.innerHTML=`<span>共 ${m.total} 条 · 当前 ${start}–${end}</span><div>${[['首页',1],['上一页',m.page-1],['下一页',m.page+1],['末页',m.pages]].map(([label,page],i)=>`<button type="button" ${(i<2?m.page<=1:m.page>=m.pages)?'disabled':''} data-action="session-page" data-page="${page}">${label}</button>${i===1?`<b>${m.page} / ${m.pages}</b>`:''}`).join('')}</div>`;
}
async function loadSessionAgents(){
  const s=await api('/service-status');
  store.sessionMeta.agents=(s.statuses||[]).map(x=>({id:x.agent,name:x.profile||x.name||x.agent}));
  if(!store.sessionMeta.agent||!store.sessionMeta.agents.some(a=>a.id===store.sessionMeta.agent)) store.sessionMeta.agent=store.sessionMeta.agents[0]?.id||'';
  const sel=$('sessionAgentSelect');if(sel)sel.innerHTML=store.sessionMeta.agents.map(a=>`<option value="${escAttr(a.id)}" ${a.id===store.sessionMeta.agent?'selected':''}>${esc(a.name)}</option>`).join('');
}
async function loadSessionResume(){
  const seq=nextRequestSequence('context');
  const box=$('sessionResumeBox');if(box)box.innerHTML='<div class="loadingState"><span></span>正在读取上下文…</div>';
  try{
    if(!store.sessionMeta.agents.length)await loadSessionAgents();
    if(!store.sessionMeta.agent){box.innerHTML='<div class="emptyState"><b>没有 Agent</b></div>';return}
    const q=new URLSearchParams({agent:store.sessionMeta.agent,page:String(store.sessionMeta.page),page_size:String(store.sessionMeta.pageSize),search:store.sessionMeta.search});
    const s=await api('/sessions?'+q.toString());if(!isLatestRequest('context',seq))return;
    store.sessionStatusCache=s.sessions||[];store.sessionMeta.total=s.total||0;store.sessionMeta.page=s.page||1;store.sessionMeta.pages=s.pages||1;store.sessionMeta.choices=s.model_choices||[];
    renderSessionResume();
  }catch(e){if(!isLatestRequest('context',seq))return;if(box)box.innerHTML='<p class="err">'+esc(e.message)+'</p>'}
}
function sessionAgentChanged(){store.sessionMeta.agent=$('sessionAgentSelect').value;store.sessionMeta.page=1;loadSessionResume()}
function sessionPageSizeChanged(){store.sessionMeta.pageSize=Number($('sessionPageSize').value)||20;store.sessionMeta.page=1;loadSessionResume()}
function searchSessions(){store.sessionMeta.search=String($('sessionSearch').value||'').trim();store.sessionMeta.page=1;loadSessionResume()}
function gotoSessionPage(page){store.sessionMeta.page=Math.max(1,Math.min(Number(page)||1,store.sessionMeta.pages));loadSessionResume();document.querySelector('#sessionResumeSection')?.scrollIntoView({behavior:'smooth',block:'start'})}
let TOOLS_CACHE=null;
const TOOLS_AGENT_OPEN=new Set();
function toolLabel(id){
  return ({web:'网页搜索',search:'仅搜索',vision:'看图',file:'读改文件',terminal:'终端',browser:'浏览器',skills:'技能',memory:'记忆',todo:'待办',clarify:'追问用户',delegation:'委派子代理',code_execution:'跑代码',cronjob:'定时任务',session_search:'搜历史会话',tts:'语音',image_gen:'生图',video:'看视频',video_gen:'生视频',computer_use:'操控桌面',x_search:'搜 X',safe:'安全组合',debugging:'调试组合',coding:'写代码组合'})[id]||id;
}
function renderAgentTools(data){
  const box=$('agentToolsBox'); if(!box)return;
  const catalog=data.catalog||[];
  const agents=data.agents||[];
  if(!agents.length){box.innerHTML='<p class="muted">没有 agent</p>';return}
  box.innerHTML=agents.map(a=>{
    const key=a.agent;
    const open=TOOLS_AGENT_OPEN.has(key);
    const on=new Set(a.enabled||[]);
    const n=catalog.filter(t=>on.has(t.id)).length;
    const hint=n?('已开 '+n+' 项'):'当前没单独开基础工具（走 Hermes 默认）';
    const chips=catalog.map(t=>{
      const onNow=on.has(t.id);
      return `<button type="button" class="toolBtn ${onNow?'on':'off'}" data-action="toggle-tool" data-agent="${escAttr(a.agent)}" data-id="${escAttr(t.id)}">${esc(toolLabel(t.id))}${onNow?' · 开':' · 关'}</button>`;
    }).join('');
    const body=!open?'':`<div class="agentConfigBody"><div class="platToolGrid">${chips}</div><div class="agentConfigActions"><span>修改后需要保存，并重启对应 Gateway 生效。</span><button type="button" class="primary" data-action="save-tools" data-agent="${escAttr(a.agent)}">保存工具设置</button></div></div>`;
    return renderFoldCard({open,action:'toggle-tools-agent',key,title:a.name,hint,count:n,countLabel:`${n} 个工具`,body});
  }).join('');
}
function toggleToolsAgent(key){if(TOOLS_AGENT_OPEN.has(key)) TOOLS_AGENT_OPEN.delete(key); else TOOLS_AGENT_OPEN.add(key); if(TOOLS_CACHE) renderAgentTools(TOOLS_CACHE)}
function toggleToolChip(btn){
  const on=btn.classList.contains('on');
  btn.classList.toggle('on',!on);
  btn.classList.toggle('off',on);
  const name=btn.textContent.replace(/\s*·\s*(开|关)\s*$/,'');
  btn.textContent=name+(on?' · 关':' · 开');
}
async function loadAgentTools(){
  const seq=nextRequestSequence('tools');
  const box=$('agentToolsBox');
  if(box && !box.dataset.loaded) box.innerHTML='<div class="inlineLoader skeleton" role="status" aria-label="正在读取数据"></div>';
  try{
    const s=await api('/toolsets');if(!isLatestRequest('tools',seq))return;
    if(box) box.dataset.loaded='1';
    TOOLS_CACHE=s;
    renderAgentTools(s);
  }catch(e){if(!isLatestRequest('tools',seq))return;if(box) box.innerHTML='<p class="err">'+esc(e.message)+'</p>'}
}
async function saveAgentTools(agent){
  const box=$('agentToolsBox');
  const enabled=[...box.querySelectorAll('button.toolBtn.on[data-agent="'+agent+'"]')].map(el=>el.dataset.id);
  if(!await askConfirm('保存 '+agent+' 的工具开关？Gateway 在跑请到设置里重启后才生效。'))return;
  try{
    const r=await api('/toolsets',{method:'POST',body:JSON.stringify({agent,enabled})});
    toast(r.hint||'已保存');
    await loadAgentTools();
  }catch(e){toast(e.message)}
}
let SKILLS_CACHE=null;
const SKILLS_AGENT_OPEN=new Set();
const SKILLS_CAT_OPEN=new Set();
const SKILLS_OFF={};
const CAT_LABEL={
  'autonomous-ai-agents':'自主代理','communications':'通讯','creative':'创作','data-science':'数据',
  'devops':'运维','github':'GitHub','mlops':'机器学习','productivity':'效率','red-teaming':'红队',
  'research':'研究','smart-home':'智能家居','software-development':'开发','uncategorized':'其它'
};
function catLabel(id){return CAT_LABEL[id]||id}
function skillsOff(agent){
  if(!SKILLS_OFF[agent]) SKILLS_OFF[agent]=new Set();
  return SKILLS_OFF[agent];
}
function renderAgentSkills(data){
  const box=$('agentSkillsBox'); if(!box)return;
  const agents=data.agents||[];
  if(!agents.length){box.innerHTML='<p class="muted">没有 agent</p>';return}
  box.innerHTML=agents.map(a=>{
    const key=a.agent;
    const open=SKILLS_AGENT_OPEN.has(key);
    const off=skillsOff(key);
    const catalog=a.catalog||[];
    const nOff=catalog.filter(t=>off.has(t.id)).length;
    const hint=catalog.length?(nOff?('已关 '+nOff+' / '+catalog.length):('已装 '+catalog.length+'，当前全开')):'这个 agent 目录里没有 skill';
    let body='';
    if(open){
      const groups={};
      catalog.forEach(t=>{(groups[t.category||'uncategorized']||(groups[t.category||'uncategorized']=[])).push(t)});
      const cats=Object.keys(groups).sort();
      body=cats.map(cat=>{
        const ck=key+'::'+cat;
        const cOpen=SKILLS_CAT_OPEN.has(ck);
        const items=groups[cat];
        const offN=items.filter(t=>off.has(t.id)).length;
        const chips=items.map(t=>{
          const onNow=!off.has(t.id);
          return `<span class="skillChipWrap"><button type="button" class="toolBtn ${onNow?'on':'off'}" data-action="toggle-skill" data-agent="${escAttr(key)}" data-id="${escAttr(t.id)}">${esc(t.id)}${onNow?' · 开':' · 关'}</button><button type="button" class="danger skillDel" data-action="delete-skill" data-agent="${escAttr(key)}" data-id="${escAttr(t.id)}">删</button></span>`;
        }).join('');
        return renderFoldCard({open:cOpen,action:'toggle-skills-cat',key:ck,title:catLabel(cat),hint:offN?('关 '+offN+' / '+items.length):items.length+' 个',count:items.length,countLabel:`${items.length} 个`,body:cOpen?`<div class="skillCategoryBody"><div class="platToolGrid">${chips}</div></div>`:''});
      }).join('');
      body=`<div class="agentConfigBody"><div class="skillCategoryList">${body}</div><div class="agentConfigActions"><span>开关和删除操作完成后，请保存这个 Agent。</span><button type="button" class="primary" data-action="save-skills" data-agent="${escAttr(a.agent)}">保存 Skills 设置</button></div></div>`;
    }
    return renderFoldCard({open,action:'toggle-skills-agent',key,title:a.name,hint,count:catalog.length-nOff,countLabel:`${catalog.length-nOff} 个启用`,body});
  }).join('');
}
function toggleSkillsAgent(key){if(SKILLS_AGENT_OPEN.has(key)) SKILLS_AGENT_OPEN.delete(key); else SKILLS_AGENT_OPEN.add(key); if(SKILLS_CACHE) renderAgentSkills(SKILLS_CACHE)}
function toggleSkillsCat(key){if(SKILLS_CAT_OPEN.has(key)) SKILLS_CAT_OPEN.delete(key); else SKILLS_CAT_OPEN.add(key); if(SKILLS_CACHE) renderAgentSkills(SKILLS_CACHE)}
function toggleSkillChip(agent,id){
  const off=skillsOff(agent);
  if(off.has(id)) off.delete(id); else off.add(id);
  if(SKILLS_CACHE) renderAgentSkills(SKILLS_CACHE);
}
async function loadAgentSkills(){
  const seq=nextRequestSequence('skills');
  const box=$('agentSkillsBox');
  if(box && !box.dataset.loaded) box.innerHTML='<div class="inlineLoader skeleton" role="status" aria-label="正在读取数据"></div>';
  try{
    const s=await api('/skills');if(!isLatestRequest('skills',seq))return;
    if(box) box.dataset.loaded='1';
    SKILLS_CACHE=s;
    (s.agents||[]).forEach(a=>{SKILLS_OFF[a.agent]=new Set(a.disabled||[])});
    renderAgentSkills(s);
  }catch(e){if(box) box.innerHTML='<p class="err">'+esc(e.message)+'</p>'}
}
async function saveAgentSkills(agent){
  const disabled=[...skillsOff(agent)];
  if(!await askConfirm('保存 '+agent+' 的 skill 开关？关掉的不会再进提示。Gateway 在跑请到设置里重启后才生效。'))return;
  try{
    const r=await api('/skills',{method:'POST',body:JSON.stringify({agent,disabled})});
    toast(r.hint||'已保存');
    await loadAgentSkills();
  }catch(e){toast(e.message)}
}
async function deleteAgentSkill(agent,name){
  if(!await askConfirm('删除 skill「'+name+'」？会移到这个 agent 的 skills/.archive，聊天里不再加载。Gateway 在跑请到设置里重启。'))return;
  try{
    const r=await api('/skills/delete',{method:'POST',body:JSON.stringify({agent,name})});
    toast(r.hint||'已删除');
    await loadAgentSkills();
  }catch(e){toast(e.message)}
}
async function resumeSession(agent,sessionId){
  if(!await askConfirm('切回这条上下文？当前这条聊天的进行中任务会断。Gateway 在跑的话请到工作状态里点重启。'))return;
  try{
    const r=await api('/sessions/resume',{method:'POST',body:JSON.stringify({agent,session_id:sessionId})});
    toast(r.hint||'已切回');
    await loadSessionResume();
  }catch(e){toast(e.message)}
}
async function deleteSession(agent,sessionId){
  if(!await askConfirm('删除这条上下文？聊天记录会从库里清掉，不能恢复。Gateway 在跑请随后到工作状态里重启。'))return;
  try{
    const r=await api('/sessions/delete',{method:'POST',body:JSON.stringify({agent,session_id:sessionId})});
    toast(r.hint||'已删除');
    await loadSessionResume();
  }catch(e){toast(e.message)}
}
async function setSessionModel(agent,sessionKey,model){
  if(!sessionKey){toast('这条没有绑定聊天对象');return}
  if(!await askConfirm('这条聊天下一条改用 '+model+'？只改这一条，不改整个 agent。Gateway 在跑请到工作状态里重启。'))return;
  try{
    const r=await api('/sessions/model',{method:'POST',body:JSON.stringify({agent,session_key:sessionKey,model})});
    toast(r.hint||'已指定模型');
    await loadSessionResume();
  }catch(e){toast(e.message)}
}
async function controlGateway(agent,action){
  const words={start:'启动',stop:'停止',restart:'重启'};
  if(action!=='start' && !await askConfirm('确定'+(words[action]||action)+' '+agentLabel(agent)+' 的 Gateway？进行中的任务会断。'))return;
  try{
    await api('/gateway-control',{method:'POST',body:JSON.stringify({agent,action})});
    toast((words[action]||action)+' '+agentLabel(agent)+' 已发出');
    await loadWorkStatus();
  }catch(e){toast(e.message)}
}
async function loadState(){const seq=nextRequestSequence('state');try{const s=await api('/state');if(!isLatestRequest('state',seq))return;store.state=s;applyAuthSettings(s);showApp();renderCurrent(s.current);renderImageGen();renderProviders(s.providers);renderCommands(s.commands);renderTestTargets(s.providers);renderRestartOptions();initPanelPage();loadAuthSettings();serviceStatus()}catch(e){if(!isLatestRequest('state',seq))return;showLogin();toast(e.message)}}
async function serviceStatus(){const seq=nextRequestSequence('serviceStatus');const box=$('serviceStatus'); if(!box)return; try{const s=await api('/service-status');if(!isLatestRequest('serviceStatus',seq))return; const list=s.statuses||[]; store.agentStatus={}; list.forEach(x=>{store.agentStatus[x.profile||x.agent]=x.status}); box.innerHTML=renderTopStatus(list,s.status); const def=list.find(x=>x.agent==='default'||x.profile==='agent1'); const down=!def||!def.ok; $('installGatewayBtn')?.classList.toggle('hidden',!down); $('restartGatewayBtn')?.classList.toggle('hidden',down); if($('gatewayActionHint')) $('gatewayActionHint').textContent=down?'Gateway 尚未运行。点击安装并启动，已填的模型与聊天平台配置会直接生效。':'重启会中断对应 agent 当前正在运行的任务；只在切换配置未生效或需要刷新聊天平台配置时使用。'; if(store.state) renderCurrent(store.state.current)}catch(e){if(!isLatestRequest('serviceStatus',seq))return;if(e?.code==='NEED_LOGIN'){showLogin();return}box.innerHTML=renderStatusChip('Gateway','unknown')}}
async function addProvider(){try{const body={name:$('addName').value,base_url:$('addUrl').value,api_key:$('addKey').value,api_mode:$('addMode').value,model:$('addModel').value,models:$('addModels').value};const r=await api('/providers',{method:'POST',body:JSON.stringify(body)});store.state=r.state;renderCurrent(store.state.current);renderProviders(store.state.providers);renderCommands(store.state.commands);renderTestTargets(store.state.providers);toast('已添加中转站')}catch(e){toast(e.message)}}
async function fetchModelsForAdd(sourceButton){
  const btn=sourceButton||null;
  const oldText=btn?btn.textContent:'';
  if(btn){btn.disabled=true;btn.textContent='获取中...'}
  try{
    const r=await api('/fetch-models',{method:'POST',body:JSON.stringify({base_url:$('addUrl').value,api_key:$('addKey').value,api_mode:$('addMode').value})});
    const models=r.models||[];
    if(!models.length) throw new Error('没有获取到模型');
    $('addModel').value=$('addModel').value||models[0];
    $('addModels').value=models.filter(m=>m!==$('addModel').value).join('\n');
    toast('已获取 '+models.length+' 个模型');
  }catch(e){toast(e.message)}
  finally{if(btn){btn.disabled=false;btn.textContent=oldText||'一键获取模型'}}
}
async function deleteProvider(id){if(!await askConfirm('确定删除这个中转站？'))return;try{const r=await api('/providers/'+id,{method:'DELETE'});store.state=r.state;renderProviders(store.state.providers);renderCommands(store.state.commands);renderTestTargets(store.state.providers);toast('已删除')}catch(e){toast(e.message)}}
async function refreshProviderModels(id){
  const btn=$('refreshModels_'+id);
  const old=btn?btn.textContent:'';
  if(btn){if(btn.disabled)return;btn.disabled=true;btn.textContent='获取中...'}
  try{
    const r=await api(`/providers/${id}/refresh-models`,{method:'POST',body:JSON.stringify({})});
    store.state=r.state;
    store.expandedProviders.add(Number(id));
    renderProviders(store.state.providers);
    renderCommands(store.state.commands);
    renderTestTargets(store.state.providers);
    const n=(r.added!=null)?r.added:((store.state.providers||[]).find(p=>Number(p.id)===Number(id))?.models||[]).length;
    toast('已重新获取 '+n+' 个模型'+(r.kept_default?'（保留原默认 '+r.kept_default+'）':''));
  }catch(e){toast(e.message)}
  finally{const b=$('refreshModels_'+id);if(b){b.disabled=false;b.textContent=old||'重新获取模型'}}
}
async function addModel(id){try{const v=$('model_'+id).value;const r=await api(`/providers/${id}/models`,{method:'POST',body:JSON.stringify({model:v})});store.state=r.state;renderProviders(store.state.providers);renderCommands(store.state.commands);renderTestTargets(store.state.providers);toast('已添加模型')}catch(e){toast(e.message)}}
async function deleteModel(id,m){if(!await askConfirm('确定删除这个模型？'))return;try{const r=await api(`/providers/${id}/models/${m}`,{method:'DELETE'});store.state=r.state;renderProviders(store.state.providers);renderCommands(store.state.commands);renderTestTargets(store.state.providers);toast('已删除模型')}catch(e){toast(e.message)}}
async function switchModel(id,m,agent='default'){
  const p=(store.state.providers||[]).find(x=>Number(x.id)===Number(id));
  const mode=apiModeLabel(p?.api_mode);
  const extra=p?.api_mode==='anthropic_messages'?'\n\n注意：这是 Claude API 格式，不是 OpenAI。切给 agent 前建议先点“测试”，并且 unlimited.surf 这类站可能轻量测试通过但 Hermes 实战被拦。':'';
  const msg=(agent==='both'?`确定把两个 Agent 都切换到 ${m}？`:`确定把 ${agentLabel(agent)} 切换到 ${m}？`)+`\n接口格式：${mode}`+extra;
  if(!await askConfirm(msg)) return;
  try{const r=await api('/switch',{method:'POST',body:JSON.stringify({providerIndex:id,model:m,agent})});store.state=r.state;renderCurrent(store.state.current);renderProviders(store.state.providers);toast('已切换 '+agentLabel(agent)+'：'+m)}catch(e){toast(e.message)}
}
async function rebuildCommands(){try{const r=await api('/rebuild-commands',{method:'POST'});store.state=r.state;renderCommands(store.state.commands);toast('快捷命令已重建')}catch(e){toast(e.message)}}
async function runTest(sourceButton){
  const target=$('testTarget').value;
  if(target.startsWith('provider-all:')){await testProviderAllModels(Number(target.split(':')[1]), true);return;}
  const body={message:$('testMessage').value};
  let label='选定范围';
  if(target==='all'){body.all=true;label='全部中转站（每站默认模型）'}
  else if(target==='current'){body.providerIndex='current';label='当前使用'}
  else if(target.startsWith('agent:')){body.agent=target.split(':')[1];label=agentLabel(body.agent)+' 当前可用'}
  else if(target.startsWith('p:')){const parts=target.split(':');body.providerIndex=Number(parts[1]);body.model=decodeURIComponent(parts.slice(2).join(':'));label=body.providerIndex+'号 / '+body.model;}
  $('testResults').innerHTML='<div class="muted">测试中，请稍等...</div>';
  appendTestLog('开始检测：'+label,'run');
  try{
    const r=await api('/test',{method:'POST',body:JSON.stringify(body),sourceButton});
    const results=r.results||[];
    renderTestResults(results);
    results.forEach(one=>appendTestLog(summarizeResult(one),resultLogType(one)));
    appendTestLog('检测完成：共 '+results.length+' 项','ok');
    toast('测试完成')
  }catch(e){
    $('testResults').innerHTML='<div class="err">'+esc(e.message)+'</div>';
    appendTestLog('检测失败：'+e.message,'bad');
    toast(e.message)
  }
}
async function testAgentCurrent(agent){
  const box=$('agent_test_'+agent);
  const label=agentLabel(agent)+' 当前模型';
  appendTestLog('开始检测：'+label,'run');
  if(box) box.innerHTML='<div class="muted">正在测试当前模型...</div>';
  try{
    const r=await api('/test',{method:'POST',body:JSON.stringify({agent,message:$('testMessage')?.value||'你好，请用一句话回复：测试成功'})});
    const html=(r.results||[]).map(oneResultHtml).join('') || '<div class="err">没有返回结果</div>';
    if(box) box.innerHTML='<div class="results">'+html+'</div>';
    (r.results||[]).forEach(one=>appendTestLog(summarizeResult(one),resultLogType(one)));
    appendTestLog('检测完成：'+label,'ok');
    toast('测试完成：'+agentLabel(agent));
  }catch(e){
    if(box) box.innerHTML='<div class="err">'+esc(e.message)+'</div>';
    appendTestLog('检测失败：'+label+' · '+e.message,'bad');
    toast(e.message);
  }
}
let BATCH_TEST_ACTIVE=false;
function setBatchTestLock(locked){BATCH_TEST_ACTIVE=locked;document.querySelectorAll('#testSection button,.provider button[data-action^="test-"]').forEach(b=>{b.disabled=locked;b.dataset.batchLocked=locked?'1':''})}
async function testProviderAllModels(providerIndex, fromTop=false){
  if(BATCH_TEST_ACTIVE){toast('批量测试正在进行');return}
  const p=(store.state.providers||[]).find(x=>Number(x.id)===Number(providerIndex));
  if(!p){toast('中转站不存在');appendTestLog('中转站不存在：'+providerIndex,'bad');return}
  setBatchTestLock(true);
  try{
  if(!fromTop && !store.expandedProviders.has(Number(providerIndex))){store.expandedProviders.add(Number(providerIndex));renderProviders(store.state.providers)}
  if(!fromTop) setTimeout(()=>document.getElementById('provider_'+providerIndex)?.scrollIntoView({behavior:'smooth',block:'start'}),60);
  const models=p.models||[];
  if(fromTop) $('testResults').innerHTML='<div class="muted">正在逐个测试 '+esc(p.name)+' 的 '+models.length+' 个模型...</div>';
  appendTestLog('开始批量检测：'+p.id+'号 '+p.name+'，共 '+models.length+' 个模型','run');
  models.forEach(m=>{const box=$(resultId(providerIndex,m)); if(box) box.innerHTML='<div class="muted">等待批量测试...</div>';});
  const results=[];
  let ok=0, bad=0;
  for(let i=0;i<models.length;i++){
    const m=models[i];
    const box=$(resultId(providerIndex,m));
    appendTestLog('['+(i+1)+'/'+models.length+'] 正在检测 '+m,'run');
    if(box) box.innerHTML='<div class="muted">正在测试 '+esc(m)+' ...</div>';
    try{
      const r=await api('/test',{method:'POST',body:JSON.stringify({providerIndex,model:m,message:$('testMessage')?.value||'你好，请用一句话回复：测试成功'})});
      const one=(r.results||[])[0];
      if(one){results.push(one); one.ok?ok++:bad++; appendTestLog(summarizeResult(one),resultLogType(one));}
      else{bad++; appendTestLog(p.id+'号 / '+m+'：没有返回结果','bad')}
      if(box) box.innerHTML='<div class="results">'+((r.results||[]).map(oneResultHtml).join('')||'<div class="err">没有返回结果</div>')+'</div>';
    }catch(e){
      bad++;
      appendTestLog(p.id+'号 / '+m+'：请求失败 · '+e.message,'bad');
      if(box) box.innerHTML='<div class="err">'+esc(e.message)+'</div>';
    }
    if(fromTop) renderTestResults(results);
  }
  appendTestLog('批量检测完成：'+p.name+' · 可用 '+ok+' / 失败 '+bad+' / 总计 '+models.length, bad?'warn':'ok');
  toast('已测试 '+models.length+' 个模型');
  }finally{setBatchTestLock(false)}
}
async function testOneModel(providerIndex, model){
  if(BATCH_TEST_ACTIVE){toast('批量测试正在进行');return}
  const box=$(resultId(providerIndex, model));
  appendTestLog('开始检测：'+providerIndex+'号 / '+model,'run');
  if(box) box.innerHTML='<div class="muted">正在测试 '+esc(model)+' ...</div>';
  try{
    const r=await api('/test',{method:'POST',body:JSON.stringify({providerIndex,model,message:$('testMessage').value||'你好，请用一句话回复：测试成功'})});
    const html=(r.results||[]).map(oneResultHtml).join('') || '<div class="err">没有返回结果</div>';
    if(box) box.innerHTML='<div class="results">'+html+'</div>';
    (r.results||[]).forEach(one=>appendTestLog(summarizeResult(one),resultLogType(one)));
    appendTestLog('检测完成：'+providerIndex+'号 / '+model,'ok');
    toast('测试完成：'+model);
  }catch(e){
    if(box) box.innerHTML='<div class="err">'+esc(e.message)+'</div>';
    appendTestLog('检测失败：'+providerIndex+'号 / '+model+' · '+e.message,'bad');
    toast(e.message);
  }
}
function oneResultHtml(r){
  const good=r.ok;
  const detail=good?('<div class="reply">'+esc(r.text)+'</div>'):('<div class="err">'+esc(r.error|| (r.empty?'HTTP 成功但返回空内容':'测试失败'))+'</div>');
  return '<div class="result '+(good?'ok':'bad')+'"><div class="rhead"><div><b>'+esc(r.providerIndex)+'号：'+esc(r.provider_name)+'</b><div class="pmeta">'+esc(r.model)+' · '+esc(r.base_url)+' · '+esc(r.api_mode)+'</div></div><span class="pill '+(good?'ok':'bad')+'">'+(good?'可用':'不可用/空回复')+' · HTTP '+esc(r.http_status)+' · '+esc(r.latency_ms)+'ms</span></div>'+detail+'</div>';
}
function renderTestResults(rs){
  $('testResults').innerHTML=rs.map(oneResultHtml).join('') || '<p class="muted">没有结果</p>';
}
function fileToBase64(file){return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(String(fr.result).split(',')[1]||'');fr.onerror=()=>reject(fr.error||new Error('读取文件失败'));fr.readAsDataURL(file);})}
async function runAsr(sourceButton){
  const f=$('asrFile').files[0];
  if(!f){toast('请先选择 mp3/wav 文件');return}
  $('asrResult').innerHTML='<div class="muted">识别中，请稍等...</div>';
  try{const audioData=await fileToBase64(f);const r=await api('/mimo/asr',{method:'POST',body:JSON.stringify({audioData,mime:f.type||(/\.wav$/i.test(f.name)?'audio/wav':'audio/mpeg'),language:$('asrLang').value}),sourceButton});$('asrResult').innerHTML='<div class="result '+(r.ok?'ok':'bad')+'"><div class="rhead"><b>ASR 结果</b><span class="pill '+(r.ok?'ok':'bad')+'">HTTP '+esc(r.http_status)+' · '+esc(r.latency_ms)+'ms</span></div>'+(r.ok?'<div class="reply">'+esc(r.text)+'</div>':'<div class="err">'+esc(r.error||'识别失败')+'</div>')+'</div>';toast('识别完成')}catch(e){$('asrResult').innerHTML='<div class="err">'+esc(e.message)+'</div>';toast(e.message)}
}
async function runTts(sourceButton){
  $('ttsResult').innerHTML='<div class="muted">生成中，请稍等...</div>';
  const body={model:$('ttsModel').value,voice:$('ttsVoice').value,format:$('ttsFormat').value,style:$('ttsStyle').value,text:$('ttsText').value};
  try{const r=await api('/mimo/tts',{method:'POST',body:JSON.stringify(body),sourceButton});if(r.ok){const format=['wav','mp3'].includes(r.format)?r.format:'';const subtype=format==='mp3'?'mpeg':'wav';const audioUrl=typeof r.audioDataUrl==='string'&&new RegExp('^data:audio/'+subtype+';base64,[A-Za-z0-9+/]+={0,2}$').test(r.audioDataUrl)?r.audioDataUrl:'';if(!format||!audioUrl)throw new Error('服务器返回的音频格式不安全');const result=document.createElement('div');result.className='result ok';const head=document.createElement('div');head.className='rhead';const title=document.createElement('b');title.textContent='TTS 生成成功';const pill=document.createElement('span');pill.className='pill ok';pill.textContent='HTTP '+r.http_status+' · '+r.latency_ms+'ms';head.append(title,pill);const audio=document.createElement('audio');audio.controls=true;audio.src=audioUrl;const actions=document.createElement('div');actions.className='actions';const link=document.createElement('a');link.download='mimo-tts.'+format;link.href=audioUrl;const button=document.createElement('button');button.textContent='下载音频';link.append(button);actions.append(link);result.append(head,audio,actions);$('ttsResult').replaceChildren(result)}else{$('ttsResult').innerHTML='<div class="result bad"><div class="err">'+esc(r.error||'生成失败')+'</div></div>'}toast('生成完成')}catch(e){$('ttsResult').innerHTML='<div class="err">'+esc(e.message)+'</div>';toast(e.message)}
}
async function createAgent(){
  const btn=$('createAgentBtn');
  const input=$('newAgentName');
  const name=(input?.value||'').trim();
  const cloneFrom=$('cloneFromAgent')?.value||'';
  const scope=$('newAgentScope')?.value||'system';
  if(!name){toast('先填名字');return}
  if(btn){if(btn.dataset.busy==='1')return;btn.dataset.busy='1';btn.disabled=true}
  try{
    toast(cloneFrom?('正在从 '+agentLabel(cloneFrom)+' 克隆 '+name+'…'):('正在新建 '+name+'…'));
    const r=await api('/agents',{method:'POST',body:JSON.stringify({name,cloneFrom,scope})});
    if(input) input.value='';
    toast('已'+(cloneFrom?'克隆':'新建')+' '+(r.agent?.profile||name)+'，去补聊天平台');
    await loadState();
  }catch(e){toast('失败：'+e.message)}
  finally{if(btn){btn.dataset.busy='';btn.disabled=false}}
}
async function deleteAgent(id,label){
  if(!id||id==='default'){toast('默认 agent 不能删');return}
  if(!await askConfirm('确定删除 '+label+'？会停掉 Gateway 并删掉这个 profile。'))return;
  try{
    toast('正在删除 '+label+'…');
    await api('/agents/'+encodeURIComponent(id),{method:'DELETE'});
    toast('已删除 '+label);
    await loadState();
  }catch(e){toast('删除失败：'+e.message)}
}
async function syncPairingScope(){
  const agent=$('pairingAgent')?.value||'default';
  if(!window.SERVICE_SCOPES){
    try{const r=await api('/service-scopes');window.SERVICE_SCOPES=r.service_scopes||{}}catch{window.SERVICE_SCOPES={}}
  }
  const saved=window.SERVICE_SCOPES?.[agent]||'auto';
  if($('serviceScope'))$('serviceScope').value=saved;
  resetPairingInput();
  const hint=$('serviceScopeHint');
  if(hint)hint.textContent='当前保存：'+(saved==='system'?'系统级':saved==='user'?'用户级':'自动识别')+(saved==='user'?'（root 用户的 systemd --user，并非普通 Linux 用户运行）':'');
}
async function loadGatewayLogs(){
  const agent=$('pairingAgent')?.value||'default',box=$('gatewayLogs');
  if(!box)return;box.classList.remove('hidden');box.innerHTML='<span class="inlineLoader compact" role="status">正在读取日志</span>';
  try{const r=await api('/gateway-logs?agent='+encodeURIComponent(agent)+'&lines=160');box.textContent=r.logs||'暂无日志'}catch(e){box.textContent='读取失败：'+e.message}
}
function readableRule(raw){
 const s=String(raw||''),l=s.toLowerCase();
 const rules=[
  [/started|startup complete|gateway.*running|application startup/i,'success','Gateway 已启动','服务已经开始运行，可以正常接收消息。','不需要操作。'],
  [/stopped|stopping|shutting down|shutdown/i,'warning','Gateway 已停止','服务目前不能接收或回复新消息。','如果不是主动停止，请到设置中检查并重新启动。'],
  [/restart|restarting/i,'warning','Gateway 正在重启','连接会短暂中断，进行中的任务可能受影响。','等待十几秒后刷新状态。'],
  [/connected|connection established|logged in|ready|polling/i,'success','聊天平台连接成功','Gateway 已经连上聊天平台，消息通道可用。','不需要操作。'],
  [/pair.*approv|authorized|authentication successful/i,'success','身份验证成功','账号或聊天配对已经通过验证。','不需要操作。'],
  [/unauthorized|forbidden|invalid token|authentication failed|401|403/i,'error','身份验证失败','Token、API Key 或登录状态可能无效，相关功能无法使用。','检查对应平台或模型的凭据，然后重启 Gateway。'],
  [/rate.?limit|too many requests|\b429\b/i,'warning','请求太频繁','上游暂时限制了请求速度，部分回复可能延迟或失败。','稍后重试；若频繁出现，请降低并发或检查套餐额度。'],
  [/timeout|timed out|deadline exceeded/i,'warning','请求超时','上游服务或网络响应过慢，本次操作可能没有完成。','先重试；持续出现时检查网络和中转站状态。'],
  [/network.*(error|unreachable)|connection refused|connection reset|dns|econn/i,'error','网络连接失败','Gateway 无法连接聊天平台或模型服务。','检查网络、域名解析和目标服务是否在线。'],
  [/config.*(reload|loaded)|configuration.*loaded/i,'success','配置已载入','Gateway 已读取最新配置。','如果刚修改设置，确认功能是否已生效。'],
  [/error|exception|traceback|failed|fatal|panic/i,'error','运行时出现异常','某项操作执行失败，相关功能可能暂时不可用。','展开原始内容查看细节；持续出现时请技术人员处理。'],
  [/warn|warning|deprecated/i,'warning','系统发出提醒','当前仍可运行，但存在需要留意的情况。','展开原始内容确认提醒内容。']
 ];
 for(const [re,level,title,impact,advice] of rules)if(re.test(s))return{level,title,impact,advice};
 return{level:'info',title:'普通运行记录',impact:'这是 Gateway 的常规运行信息，暂未发现明确异常。',advice:'通常不需要操作；需要技术细节时可展开原始内容。'};
}
function parseReadableLog(line,index){const m=String(line).match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+([^\s]+)\s+([^:]+):\s?(.*)$/);const raw=String(line);const rule=readableRule(raw);return{id:index,time:m?.[1]?.replace('T',' ')||'',module:m?.[3]?.trim()||'Gateway',message:m?.[4]||raw,raw,...rule}}
function renderReadableLogs(){
 const box=$('readableLogs'),sum=$('readableSummary');if(!box)return;const filter=$('readableLevel')?.value||'all';
 let items=store.readableLogEvents.filter(x=>filter==='all'||(filter==='error'?x.level==='error':filter==='warning'?['error','warning'].includes(x.level):x.level==='success'));
 const counts=store.readableLogEvents.reduce((a,x)=>(a[x.level]=(a[x.level]||0)+1,a),{});
 if(sum)sum.innerHTML=`<span class="readableStat">共 <b>${store.readableLogEvents.length}</b> 条</span><span class="readableStat">异常 <b>${counts.error||0}</b></span><span class="readableStat">提醒 <b>${counts.warning||0}</b></span><span class="readableStat">正常 <b>${counts.success||0}</b></span><span class="readableStat">更新于 <b>${esc(nowTime())}</b></span>`;
 if(!items.length){box.innerHTML=emptyState(filter==='all'?'暂时没有日志':'没有符合筛选条件的日志','可以刷新或切换显示级别');return}
 box.innerHTML=items.map(x=>`<article class="readableEvent ${x.level}"><span class="readableEventDot"></span><div><div class="readableEventHead"><h3>${esc(x.title)}</h3><time>${esc(x.time||'时间未知')}</time></div><div class="readableMeta"><span class="readableTag">${esc(x.module)}</span><span class="readableTag">${x.level==='error'?'异常':x.level==='warning'?'提醒':x.level==='success'?'正常':'信息'}</span></div><div class="readableExplain"><div><b>有什么影响</b><p>${esc(x.impact)}</p></div><div><b>建议怎么做</b><p>${esc(x.advice)}</p></div></div><details class="readableRaw"><summary>查看原始内容</summary><pre>${esc(x.raw)}</pre></details></div></article>`).join('')
}
function fillReadableAgents(){const sel=$('readableAgent');if(!sel)return;const keep=sel.value;const agents=knownAgents();sel.innerHTML=agents.map(a=>`<option value="${escAttr(a.id)}">${esc(a.name||a.profile||a.id)}</option>`).join('');if([...sel.options].some(o=>o.value===keep))sel.value=keep}
async function loadReadableLogs(){
 const seq=nextRequestSequence('logs');
 const box=$('readableLogs'),btn=$('readableRefreshBtn');if(!box)return;fillReadableAgents();const agent=$('readableAgent')?.value||'default',lines=$('readableLines')?.value||160;if(btn?.dataset.busy==='1')return;
 try{if(btn){btn.dataset.busy='1';btn.disabled=true;btn.classList.add('loadingBtn');btn.textContent='读取中'}box.innerHTML='<span class="inlineLoader skeleton" role="status">正在翻译日志</span>';const r=await api('/gateway-logs?agent='+encodeURIComponent(agent)+'&lines='+encodeURIComponent(lines));if(!isLatestRequest('logs',seq))return;store.readableLogEvents=String(r.logs||'').split(/\r?\n/).filter(Boolean).map(parseReadableLog).reverse();renderReadableLogs()}catch(e){if(!isLatestRequest('logs',seq))return;box.innerHTML=emptyState('日志读取失败',e.message||'请稍后重试');toast('日志读取失败：'+e.message)}finally{if(isLatestRequest('logs',seq)&&btn){btn.dataset.busy='';btn.disabled=false;btn.classList.remove('loadingBtn');btn.textContent='↻ 刷新'}}
}
async function saveServiceScope(){
  const agent=$('pairingAgent')?.value||'default',scope=$('serviceScope')?.value||'auto',btn=$('saveScopeBtn');
  if(btn?.dataset.busy==='1')return;
  try{if(btn){btn.dataset.busy='1';btn.disabled=true;btn.classList.add('loadingBtn');btn.textContent='保存中'}const r=await api('/service-scope',{method:'POST',body:JSON.stringify({agent,scope})});window.SERVICE_SCOPES=window.SERVICE_SCOPES||{};window.SERVICE_SCOPES[agent]=scope;if($('serviceScopeHint'))$('serviceScopeHint').textContent='已保存：'+(scope==='system'?'系统级':scope==='user'?'用户级':'自动识别')+'（当前识别 '+(r.detected==='user'?'用户级':'系统级')+'）';toast('服务层级已保存')}catch(e){toast('保存失败：'+e.message)}finally{if(btn){btn.dataset.busy='';btn.disabled=false;btn.classList.remove('loadingBtn');btn.textContent='保存服务层级'}}
}
function normalizePairingCode(input){if(input)input.value=String(input.value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,16)}
function resetPairingInput(){const input=$('pairingCode'),hint=$('pairingHint');if(input)input.value='';if(hint){hint.textContent='只批准你确认身份的用户；配对码通常只能使用一次。';hint.style.color='var(--muted)'}}
async function approvePairing(){
  const platform=$('pairingPlatform')?.value||'';
  const code=String($('pairingCode')?.value||'').trim().toUpperCase();
  const btn=$('approvePairingBtn'),hint=$('pairingHint');
  if(!/^[A-Z0-9]{6,16}$/.test(code)){toast('请输入正确的配对码');if(hint){hint.textContent='配对码格式不正确';hint.style.color='var(--red)'}$('pairingCode')?.focus();return}
  if(!await askConfirm('确定批准 '+platform+' 配对码 '+code+'？请先确认这是你认识的用户。'))return;
  if(btn?.dataset.busy==='1')return;
  try{
    if(btn){btn.dataset.busy='1';btn.disabled=true;btn.textContent='正在批准...'}
    if(hint){hint.textContent='正在批准配对...';hint.style.color='var(--muted)'}
    const agent=$('pairingAgent')?.value||'default',scope=$('serviceScope')?.value||'auto';
    const r=await api('/pairing-approve',{method:'POST',body:JSON.stringify({agent,scope,platform,code})});
    if(hint){hint.textContent='配对已批准';hint.style.color='var(--green)'}
    if($('pairingCode'))$('pairingCode').value='';
    toast('配对已批准');
  }catch(e){
    if(hint){hint.textContent=e.message||'批准失败';hint.style.color='var(--red)'}
    toast('批准失败：'+(e.message||'未知错误'));
  }finally{if(btn){btn.dataset.busy='0';btn.disabled=false;btn.textContent='批准配对'}}
}

async function installGateway(){
  if(!await askConfirm('确定安装并启动 agent1 Gateway？会使用当前已保存的模型和聊天平台配置。'))return;
  const btn=$('installGatewayBtn'); if(btn){if(btn.dataset.busy==='1')return;btn.dataset.busy='1';btn.disabled=true}
  try{toast('正在安装并启动 Gateway...');const r=await api('/gateway-install',{method:'POST',body:JSON.stringify({agent:'default'})});if(!r.ok)throw new Error('Gateway 未能启动');toast('Gateway 已安装并启动');await serviceStatus();await loadWorkStatus()}
  catch(e){toast('安装失败：'+(e?.message||'请稍后重试'))}
  finally{if(btn){btn.dataset.busy='';btn.disabled=false}}
}
async function restartGateway(sourceButton){const agent=$('restartAgent')?.value||'default';if(!await askConfirm('确定重启 '+agentLabel(agent)+' 的 Gateway？会中断对应 agent 当前正在运行的任务。'))return;try{toast('正在重启 '+agentLabel(agent)+' Gateway...');await api('/restart-gateway',{method:'POST',body:JSON.stringify({agent}),sourceButton});toast(agentLabel(agent)+' Gateway 已重启');await serviceStatus()}catch(e){toast('重启失败：'+(e?.message||'请稍后重试'))}}

const DYNAMIC_ACTIONS={
 'fetch-image-models':b=>fetchImageModels(b.dataset.agent),'switch-image-gen':b=>switchImageGen(b.dataset.agent),
 'test-agent-current':b=>testAgentCurrent(b.dataset.agent),'delete-agent':b=>deleteAgent(b.dataset.agent,b.dataset.label),
 'switch-model':b=>switchModel(Number(b.dataset.provider),b.dataset.model,b.dataset.agent),'delete-model':b=>deleteModel(Number(b.dataset.provider),encodeURIComponent(b.dataset.model)),
 'test-model':b=>testOneModel(Number(b.dataset.provider),b.dataset.model),'refresh-provider':b=>refreshProviderModels(Number(b.dataset.provider)),
 'test-provider-all':b=>testProviderAllModels(Number(b.dataset.provider)),'delete-provider':b=>deleteProvider(Number(b.dataset.provider)),
 'open-mimo':b=>openMimoAudio(Number(b.dataset.provider)),'toggle-provider':b=>toggleProviderModels(Number(b.dataset.provider)),'add-model':b=>addModel(Number(b.dataset.provider)),
 'toggle-platform':b=>togglePlatForm(b.dataset.agent,b.dataset.platform),'disable-platform':b=>disableChatPlatform(b.dataset.agent,b.dataset.platform,b.dataset.label),
 'save-platform':b=>saveChatPlatform(b.dataset.agent,b.dataset.platform,b),'gateway-control':b=>controlGateway(b.dataset.agent,b.dataset.control),
 'resume-session':b=>resumeSession(b.dataset.agent,b.dataset.session),'delete-session':b=>deleteSession(b.dataset.agent,b.dataset.session),'session-page':b=>gotoSessionPage(Number(b.dataset.page)),
 'toggle-tool':b=>toggleToolChip(b),'save-tools':b=>saveAgentTools(b.dataset.agent),'toggle-tools-agent':b=>toggleToolsAgent(b.dataset.key),
 'toggle-skill':b=>toggleSkillChip(b.dataset.agent,b.dataset.id),'delete-skill':b=>deleteAgentSkill(b.dataset.agent,b.dataset.id),
 'toggle-skills-cat':b=>toggleSkillsCat(b.dataset.key),'save-skills':b=>saveAgentSkills(b.dataset.agent),'toggle-skills-agent':b=>toggleSkillsAgent(b.dataset.key)
};
document.addEventListener('click',event=>{const b=event.target.closest('[data-action]');if(!b||b.disabled)return;const fn=DYNAMIC_ACTIONS[b.dataset.action];if(fn){event.preventDefault();Promise.resolve().then(()=>fn(b)).catch(error=>{console.error(error);toast(error?.message||'操作失败，请稍后重试')})}});
document.addEventListener('change',e=>{const el=e.target.closest('select[data-action="session-model"]');if(el?.value)setSessionModel(el.dataset.agent,el.dataset.sessionKey,el.value,el)});
loadState();
