'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const webSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'codex2frp-client.js'), 'utf8');
const launcherSource = fs.readFileSync(path.join(__dirname, '..', 'windows', 'launcher', 'Codex2FrpLauncher.cs'), 'utf8');
const cdpLauncherSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'launch-main-codex-cdp.ps1'), 'utf8');

function functionBody(name, source = serverSource) {
  const marker = `function ${name}`;
  let start = source.indexOf(marker);
  if (start < 0) start = source.indexOf(`async ${marker}`);
  assert.notEqual(start, -1, `${name} exists`);
  const signatureEnd = source.indexOf(') {', start);
  const brace = signatureEnd >= 0 ? signatureEnd + 2 : source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, index);
    }
  }
  throw new Error(`${name} body not found`);
}

test('send path prefers CDP editor insertion and button click before Windows key fallback', () => {
  assert.match(serverSource, /async function sendTextViaCodexCdp/, 'CDP send helper exists');
  assert.match(serverSource, /PointerEvent\('pointerdown'/, 'CDP focus simulates a real pointer press on the Codex composer');
  assert.match(serverSource, /Input\.insertText/, 'CDP helper inserts text directly into Codex editor');
  assert.match(serverSource, /clickCodexSendButtonInCdpClient/, 'CDP helper clicks the real Codex send button');

  const pasteBody = functionBody('pasteAndEnter');
  assert.match(pasteBody, /sendTextViaCodexCdp/, 'pasteAndEnter tries the CDP path for Codex text sends');
  assert.match(pasteBody, /pressPasteAndSubmit/, 'pasteAndEnter keeps a Windows fallback');
});

test('/send accepts delivery quickly and leaves new-thread discovery to status polling', () => {
  const sendBody = functionBody('handleSend');
  assert.doesNotMatch(sendBody, /await\s+waitForCodexSessionFileForNewSend/, 'handleSend does not block on new-thread session discovery');
  assert.match(sendBody, /delivery:\s*'accepted'/, 'handleSend marks delivery as accepted once automation is invoked');
  assert.match(sendBody, /watch/, 'handleSend returns watch metadata for frontend polling');
});

test('mobile slash commands are routed to explicit composer actions instead of task send', () => {
  assert.match(serverSource, /function mobileComposerCommandForText/, 'backend recognizes mobile-entered slash commands');
  assert.match(serverSource, /async function runCodexComposerAction/, 'backend exposes a shared composer action runner');
  assert.match(serverSource, /async function handleComposerAction/, 'backend exposes an authenticated composer action endpoint');
  assert.match(serverSource, /\/codex\/composer-action/, 'composer action route is registered');

  const sendBody = functionBody('handleSend');
  assert.match(sendBody, /mobileComposerCommandForText\(text\)/, '/send checks whether the text is a mobile command');
  assert.match(sendBody, /runCodexComposerAction\(selectedThreadId,\s*mobileCommand\.action/, '/send dispatches recognized commands to composer actions');
  assert.doesNotMatch(sendBody, /pasteAndEnter\(text[\s\S]{0,240}mobileCommand/, 'recognized slash commands do not continue into ordinary paste/send delivery');

  const actionBody = functionBody('runCodexComposerAction');
  assert.match(actionBody, /selectCodexSlashCommandViaCdp/, 'compact commands open the Codex slash-command picker');
  assert.doesNotMatch(actionBody, /clickCodexCompactConversationViaCdp/, 'compact commands do not search for a standalone compact button');
  assert.doesNotMatch(actionBody, /clickCodexSendButtonInCdpClient|sendTextViaCodexCdp/, 'slash commands are not submitted through the ordinary send button');
});

test('composer actions cover compact, goal, plan, and exact plus menu item entry points', () => {
  const actionBody = functionBody('runCodexComposerAction');
  assert.match(serverSource, /async function activateCodexThreadViaExistingCdp/, 'composer actions can return from Codex plugin pages to an existing thread without a new window');
  assert.match(serverSource, /async function activateCodexThreadForComposerAction/, 'composer actions have a thread activation guard');
  assert.match(serverSource, /function assertCodexComposerActionThreadIdle/, 'composer actions check thread runtime state before any UI click');
  assert.match(actionBody, /assertCodexComposerActionThreadIdle\(threadId\)[\s\S]*activateCodexThreadForComposerAction\(threadId\)/, 'composer actions refuse running threads before activating or clicking the desktop UI');
  assert.match(actionBody, /activateCodexThreadForComposerAction\(threadId\)/, 'composer actions activate the selected thread before looking for the input plus button');
  assert.match(actionBody, /case 'compact'/, 'compact action is handled explicitly');
  assert.match(actionBody, /case 'goal'/, 'goal mode action is handled explicitly');
  assert.match(actionBody, /case 'plan'/, 'plan mode action is handled explicitly');
  assert.match(actionBody, /case 'plus-menu-item'/, 'exact desktop plus menu items are handled explicitly');
  assert.match(actionBody, /selectCodexSlashCommandViaCdp\(\[['"]压缩/, 'compact action chooses the Codex slash-menu compact command');
  assert.match(actionBody, /selectCodexPlusMenuItemViaCdp/, 'goal, plan, and plugin tools use the composer plus menu hierarchy');
  assert.doesNotMatch(actionBody, /focusTarget\('codex'/, 'composer actions must not activate codex:// and open another client window');
  assert.doesNotMatch(actionBody, /activateCodexThread\(/, 'composer actions must not deep-link threads before CDP menu actions');
  assert.doesNotMatch(actionBody, /case 'goal'[\s\S]{0,180}clickCodexComposerBottomButtonViaCdp/, 'goal is not searched as a loose bottom-screen button');
  assert.doesNotMatch(actionBody, /case 'plan'[\s\S]{0,180}clickCodexComposerBottomButtonViaCdp/, 'plan is not searched as a loose bottom-screen button');
  assert.match(actionBody, /case 'plus-menu-item'[\s\S]{0,260}selectCodexPlusMenuItemViaCdp\(\[target\]\)/, 'exact plus menu item actions select the matching desktop plus row');
  assert.doesNotMatch(actionBody, /case 'plus-menu-item'[\s\S]{0,260}clickCodexSidebarButtonViaCdp/, 'plugin tool rows are not opened through the left sidebar plugin entry');
  assert.doesNotMatch(actionBody, /pasteAndEnter|sendTextViaCodexCdp/, 'composer actions do not submit ordinary task text');

  const cdpThreadBody = functionBody('activateCodexThreadViaExistingCdp');
  assert.match(cdpThreadBody, /findCodexCdpTarget\(\{\s*autoOpen:\s*false\s*\}\)/, 'thread activation for composer actions requires the existing controlled Codex window');
  assert.match(cdpThreadBody, /data-app-action-sidebar-thread-id/, 'thread activation clicks Codex sidebar thread rows by id');
  assert.doesNotMatch(cdpThreadBody, /openWindowsUri|codexThreadDeepLink/, 'composer thread activation does not use protocol links that can open another client');
});

test('new thread actions reuse existing CDP client without opening codex protocol windows', () => {
  assert.match(serverSource, /async function createNewCodexThreadViaExistingCdp/, 'new-thread has a CDP-only creation helper');
  const createBody = functionBody('createNewCodexThreadViaExistingCdp');
  assert.match(createBody, /findCodexCdpTarget\(\{\s*autoOpen:\s*false/, 'new-thread creation requires an existing controlled Codex window');
  assert.match(createBody, /dispatchCodexShortcutInCdpClient\(client,\s*'n'/, 'new-thread creation uses a CDP shortcut in the existing window');
  assert.doesNotMatch(createBody, /openWindowsUri|activateCodexThread|activateNewCodexThread|activateNewProjectlessCodexThread/, 'new-thread CDP helper never uses codex:// deep links');
  assert.match(functionBody('dispatchCodexShortcutInCdpClient'), /Input\.dispatchKeyEvent/, 'CDP shortcut helper sends keyboard events through the existing page');

  const handlerBody = functionBody('handleNewCodexThread');
  assert.match(handlerBody, /createNewCodexThreadViaExistingCdp\(target\)/, 'new-thread endpoint uses the CDP-only helper');
  assert.doesNotMatch(handlerBody, /activateNewCodexThread|activateNewProjectlessCodexThread|openWindowsUri/, 'new-thread endpoint never opens a Codex protocol window');

  const focusBody = functionBody('focusTarget');
  assert.match(focusBody, /threadId\s*&&\s*isCodexThreadId\(threadId\)/, 'empty-thread sends do not activate codex:// before first message');
});

test('compact slash action uses an existing CDP target and does not submit text', () => {
  assert.match(serverSource, /async function selectCodexSlashCommandViaCdp/, 'backend has a dedicated slash-command selector');

  const slashBody = functionBody('selectCodexSlashCommandViaCdp');
  assert.match(slashBody, /findCodexCdpTarget\(\{\s*autoOpen:\s*false\s*\}\)/, 'slash commands reuse the current Codex client and never auto-open codex://');
  assert.match(slashBody, /Input\.insertText[\s\S]*text:\s*String\(inputText/, 'slash commands type into the empty composer');
  assert.match(slashBody, /findCodexSlashCommandMenuItem/, 'slash commands select from the opened command menu');
  assert.match(slashBody, /clearCodexComposerViaCdpClient/, 'slash commands clean up the temporary slash text on failure');
  assert.doesNotMatch(slashBody, /Input\.insertText[\s\S]*\/压缩/, 'slash commands only type "/" and never type a filtered command');
  assert.doesNotMatch(slashBody, /clickCodexSendButtonInCdpClient|sendTextViaCodexCdp|focusTarget\('codex'/, 'slash commands never submit ordinary text or deep-link a new window');
});

test('Codex menu reader includes slash-command list rows', () => {
  const menuBody = functionBody('codexModeMenuItems');
  assert.match(menuBody, /listNavigationItem\s*===\s*true/, 'slash command rows are data-list-navigation-item buttons, not role menuitems');
});

test('compact action reports running Codex state instead of clicking stop controls', () => {
  assert.match(serverSource, /function hasCodexRunningStopControl/, 'backend recognizes when Codex is currently running');

  const slashBody = functionBody('selectCodexSlashCommandViaCdp');
  assert.match(slashBody, /hasCodexRunningStopControl\(snapshot\)/, 'compact action checks for running state before typing into the composer');
  assert.match(slashBody, /CODEX_COMPACT_UNAVAILABLE_WHILE_RUNNING/, 'running-state compact failure has a stable error code');
  assert.doesNotMatch(slashBody, /clickCodexSendButtonInCdpClient|sendTextViaCodexCdp/, 'compact action never falls back to sending text');
});

test('desktop composer plus menu can be read as grouped mobile options', () => {
  assert.match(serverSource, /async function readCodexPlusMenuItemsViaCdp/, 'backend can read the live desktop composer plus menu');
  assert.match(serverSource, /async function handleComposerPlusMenu/, 'backend exposes an authenticated plus-menu reader endpoint');
  assert.match(serverSource, /\/codex\/composer-plus-menu/, 'plus-menu reader route is registered');
  assert.match(serverSource, /function normalizeCodexPlusMenuItem/, 'plus-menu rows are normalized for mobile display');
  assert.match(serverSource, /function fallbackCodexPlusMenuItems/, 'plus-menu endpoint has a built-in mobile fallback when Codex CDP is unavailable');
  assert.match(serverSource, /function findKnownCodexPlusMenuRow/, 'plus-menu reader filters out unrelated Codex menus');
  assert.match(serverSource, /section:\s*'Add'/, 'plus-menu response keeps the Add group');
  assert.match(serverSource, /section:\s*'插件'/, 'plus-menu response keeps the plugin group');
  assert.match(serverSource, /section:\s*'Files and chats'/, 'plus-menu response keeps the files and chats group');

  const readerBody = functionBody('readCodexPlusMenuItemsViaCdp');
  const normalizeBody = functionBody('normalizeCodexPlusMenuItem');
  const knownRowsBody = functionBody('knownCodexPlusMenuRows');
  const knownRowBody = functionBody('findKnownCodexPlusMenuRow');
  assert.match(readerBody, /findCodexPlusButton/, 'reader opens the real composer plus button');
  assert.match(readerBody, /data-list-navigation-item/, 'reader only returns real Codex list-navigation rows');
  assert.match(serverSource, /function mergeCodexPlusMenuItems/, 'reader can merge rows collected across multiple menu scroll positions');
  assert.match(serverSource, /async function scrollCodexPlusMenuInCdpClient/, 'reader can scroll the opened desktop plus menu');
  assert.match(readerBody, /for \(let index = 0; index < 6; index \+= 1\)/, 'reader checks more than the first visible plus-menu page');
  assert.match(readerBody, /mergeCodexPlusMenuItems\(collected,\s*visibleItems\)/, 'reader keeps rows from earlier and later scroll positions');
  assert.match(functionBody('readCodexModeMenuSnapshot'), /lines:\s*linesOf\(el\)/, 'CDP snapshots preserve menu row line breaks for dynamic plugin titles');
  assert.doesNotMatch(functionBody('codexPlusMenuItemsFromSnapshot'), /findKnownCodexPlusMenuRow\(item\.text\)/, 'plus menu reader does not drop newly installed plugin rows just because they are not hard-coded');
  assert.match(normalizeBody, /rawLines\[0\][\s\S]*section:\s*'插件'/, 'unknown plus-menu rows are still exposed as plugin options with their real title');
  assert.match(knownRowsBody, /Files and folders/, 'normalizer recognizes the desktop file/folder add row');
  assert.match(knownRowsBody, /Documents/, 'normalizer recognizes document plugin rows');
  assert.match(knownRowsBody, /Superpowers/, 'normalizer recognizes installed plugin rows');
  assert.match(knownRowBody, /rawCompact/, 'normalizer handles DOM textContent that joins titles and descriptions without spaces');
  assert.match(knownRowBody, /startsWith\(row\.label\)/, 'normalizer splits labels from joined menu text by known row prefixes');
  assert.doesNotMatch(readerBody, /clickCodexSidebarButtonViaCdp/, 'reader never inspects the left sidebar plugin entry');

  const handlerBody = functionBody('handleComposerPlusMenu');
  assert.match(handlerBody, /fallbackCodexPlusMenuItems\(error\)/, 'plus-menu endpoint returns fallback rows instead of failing when live CDP is unavailable');
  assert.doesNotMatch(handlerBody, /json\(res,\s*500/, 'plus-menu endpoint does not make missing CDP a fatal mobile UI error');
});

test('composer plus lookup is anchored to the editor instead of sidebar buttons', () => {
  assert.match(serverSource, /composerEditor/, 'CDP snapshots include the visible composer editor rect');
  assert.match(functionBody('readCodexModeMenuSnapshot'), /rect\.bottom\s*>=\s*0[\s\S]*rect\.y\s*<=\s*innerHeight/, 'CDP snapshots ignore off-screen stale DOM controls');
  assert.match(functionBody('isCodexStopControlText'), /interrupt|cancel/, 'running-state detection accepts current Codex stop or interruption labels');
  const plusBody = functionBody('findCodexPlusButton');
  assert.match(plusBody, /snapshot\.composerEditor/, 'plus lookup starts from the composer editor rect');
  assert.match(plusBody, /Add files and more/, 'plus lookup accepts the current Codex composer add button label');
  assert.doesNotMatch(plusBody, /Number\(rect\.x \|\| 0\) < 120/, 'plus lookup no longer treats left-sidebar buttons as candidates');
  assert.match(serverSource, /function findCodexSidebarButton/, 'sidebar actions have a dedicated selector');
});

test('CDP target discovery prefers the main Codex window over overlay pages', () => {
  const probeBody = functionBody('probeCodexCdpTarget');
  assert.match(probeBody, /item\.url === 'app:\/\/-\/index\.html'/, 'target discovery first accepts the exact main Codex window URL');
  assert.match(probeBody, /!String\(item\.url \|\| ''\)\.includes\('initialRoute='/, 'target discovery avoids avatar-overlay routes before falling back');
});

test('composer plus menu item selection is confined to the opened plus menu', () => {
  assert.match(serverSource, /listNavigationItem/, 'CDP snapshots expose Codex list-navigation menu items');
  assert.match(serverSource, /function findCodexPlusMenuItem/, 'plus menu actions have a dedicated menu-item selector');
  const plusMenuBody = functionBody('findCodexPlusMenuItem');
  assert.match(plusMenuBody, /item\.listNavigationItem/, 'plus menu item lookup requires Codex menu navigation items');
  assert.match(plusMenuBody, /snapshot\.composerEditor/, 'plus menu item lookup is anchored near the composer editor');
  assert.match(plusMenuBody, /editorBottom \+ verticalReach/, 'plus menu item lookup supports Codex opening the plus menu below the composer');
  assert.doesNotMatch(plusMenuBody, /codexModeMenuItems\(snapshot\)/, 'plus menu item lookup does not scan arbitrary chat buttons');
  const selectBody = functionBody('selectCodexPlusMenuItemViaCdp');
  assert.match(serverSource, /async function findCodexPlusMenuItemWithScroll/, 'plus menu selection can scroll to off-screen plugin rows');
  assert.match(functionBody('findCodexPlusMenuItemWithScroll'), /findCodexPlusMenuItem\(latestSnapshot,\s*labels\)/, 'scrolling plus-menu lookup still uses the confined selector');
  assert.match(selectBody, /findCodexPlusMenuItemWithScroll\(client,\s*targetLabels,\s*snapshot\)/, 'plus menu selection uses the scrolling confined selector');
  assert.doesNotMatch(selectBody, /findCodexCommandMenuItem\(snapshot,\s*targetLabels\)/, 'plus menu selection does not reuse the broad command finder');
});

test('plus menu insertion is verified and can be removed from the Codex composer', () => {
  assert.match(serverSource, /async function readCodexComposerReferenceStateInCdpClient/, 'backend can read system composer references after a plus-menu click');
  assert.match(serverSource, /async function verifyCodexComposerReferenceInserted/, 'backend verifies that plugin or mode references actually enter the composer');
  assert.match(serverSource, /async function removeCodexPlusMenuItemViaCdp/, 'backend can remove a previously inserted composer reference');
  assert.match(serverSource, /function isPluginComposerSelection/, 'backend distinguishes plugin references from Add references when removing composer selections');
  assert.match(serverSource, /async function removeCodexPluginReferenceByEditingCdpClient/, 'backend removes plugin references by editing the composer content instead of clicking the chip');
  assert.match(functionBody('removeCodexPluginReferenceByEditingCdpClient'), /cdpPressKey\(client,\s*'Backspace'/, 'plugin removal first uses Backspace after positioning the caret around the plugin token');
  assert.match(functionBody('removeCodexPluginReferenceByEditingCdpClient'), /cdpPressKey\(client,\s*'Delete'/, 'plugin removal can select and Delete the plugin token if Backspace is insufficient');
  assert.match(serverSource, /function shouldVerifyCodexPlusMenuInsertion/, 'backend distinguishes insertable references from file-picker actions');
  assert.match(serverSource, /async function clickCodexPlusButtonDomFallback/, 'plus-menu opening has a DOM fallback when CDP mouse dispatch stalls');
  assert.match(serverSource, /async function clickCodexPlusMenuItemDomFallback/, 'plus-menu item insertion has a DOM fallback when CDP mouse dispatch does not insert a reference');
  assert.match(serverSource, /async function clickCodexPlusMenuItemWithFallback/, 'plus-menu item clicks verify insertion before falling back');
  assert.match(functionBody('verifyCodexComposerReferenceInserted'), /section:\s*selected && selected\.section/, 'verified composer references preserve the real desktop plus-menu section for mobile chips');

  const selectBody = functionBody('selectCodexPlusMenuItemViaCdp');
  const plusClickBody = functionBody('clickCodexPlusRectWithoutSendCheck');
  assert.match(selectBody, /hasCodexRunningStopControl\(snapshot\)/, 'plus-menu insertion refuses to report success while Codex is actively running');
  assert.match(plusClickBody, /assertSafeCdpClickTarget\(client,\s*x,\s*y\)/, 'plus-menu opening uses the same dangerous-click guard as other CDP clicks');
  assert.match(plusClickBody, /catch \(error\)[\s\S]*clickCodexPlusButtonDomFallback\(client,\s*rect\)/, 'plus-menu opening falls back only after the guarded mouse click path stalls');
  assert.match(functionBody('assertSafeCdpClickTarget'), /isCodexStopControlText\(text\)/, 'low-level CDP click guard refuses stop and interruption controls even if selectors are wrong');
  assert.match(functionBody('clickCodexPlusMenuItemWithFallback'), /readCodexComposerReferenceStateInCdpClient\(client,\s*labels\)/, 'plus-menu item fallback is only used after checking whether the reference was inserted');
  assert.match(selectBody, /clickCodexPlusMenuItemWithFallback\(client,\s*item,\s*targetLabels\)/, 'plus-menu selection uses the verified click helper instead of a bare mouse click');
  assert.match(selectBody, /verifyCodexComposerReferenceInserted\(client,\s*targetLabels/, 'plus-menu action verifies the selected item becomes a composer reference');
  assert.match(serverSource, /CODEX_COMPOSER_REFERENCE_NOT_INSERTED/, 'unverified plus-menu clicks have a stable failure code');

  const actionBody = functionBody('runCodexComposerAction');
  assert.match(serverSource, /async function focusCurrentCodexComposerForComposerAction/, 'composer actions can fall back to the current controlled Codex window when the selected sidebar row is not visible');
  assert.match(functionBody('activateCodexThreadForComposerAction'), /focusCurrentCodexComposerForComposerAction\(threadId,\s*result\)/, 'missing sidebar rows no longer block plugin insertion in the current Codex window');
  assert.match(actionBody, /case 'remove-plus-menu-item'/, 'composer actions expose a remove operation for mobile chip deletion');
  assert.match(actionBody, /removeCodexPlusMenuItemViaCdp\(\[target\],\s*selectionHint\)/, 'remove action forwards selection metadata so plugins and Add references use their correct cancellation behavior');
  assert.match(functionBody('handleComposerAction'), /payload\.selection[\s\S]*runCodexComposerAction\(threadId,\s*action,\s*target,\s*selection\)/, 'composer action endpoint accepts selection metadata from mobile');
  assert.match(actionBody, /selection:\s*result\.selection/, 'insert action returns the verified composer reference to the mobile client');
  assert.doesNotMatch(actionBody, /case 'plus-menu-item'[\s\S]{0,360}message:\s*`\$\{target\} opened in Codex\.`/, 'insert action does not claim success merely because a menu row was clicked');
});

test('mobile pairing token is persisted across backend restarts', () => {
  assert.match(serverSource, /MOBILE_TYPER_TOKEN_FILE/, 'backend supports an explicit persisted mobile token file');
  assert.match(serverSource, /loadOrCreateMobileToken\(TOKEN_FILE\)/, 'backend reads the persisted token when MOBILE_TYPER_TOKEN is not provided');
  assert.match(functionBody('loadOrCreateMobileToken'), /fs\.readFileSync\(file,\s*'utf8'\)\.trim\(\)/, 'persisted token is read before generating a new one');
  assert.match(functionBody('loadOrCreateMobileToken'), /fs\.writeFileSync\(file,\s*`\$\{token\}\\n`/, 'newly generated tokens are written back for later restarts');
});

test('model switching verifies the live CDP client before reporting success', () => {
  assert.match(serverSource, /async function focusCodexComposerViaCdp/, 'CDP composer focus helper exists');
  assert.match(serverSource, /async function ensureCodexCdpReady/, 'backend can automatically prepare the Codex CDP control port');
  assert.match(serverSource, /function runCodexCdpLauncher/, 'backend can invoke the Windows Codex CDP launcher');
  assert.match(serverSource, /\/codex\/control-port/, 'backend exposes an authenticated control-port preparation endpoint');
  assert.match(functionBody('findCodexCdpTarget'), /options\.autoOpen !== true/, 'ordinary CDP target discovery must not auto-open a new Codex client');
  assert.match(functionBody('findCodexCdpTarget'), /ensureCodexCdpReady/, 'explicit CDP target discovery can repair a missing control port');
  assert.match(functionBody('ensureCodexCdpReady'), /options\.autoOpen !== true/, 'control-port preparation only launches Codex for explicit auto-open requests');
  assert.match(functionBody('runCodexCdpLauncher'), /'-CdpAddress'[\s\S]*CODEX_CDP_HOST/, 'launcher preserves the configured CDP host instead of rewriting it');
  assert.doesNotMatch(functionBody('runCodexCdpLauncher'), /CODEX_CDP_HOST === '127\.0\.0\.1'\s*\?\s*'localhost'/, 'launcher must not rewrite 127.0.0.1 to localhost because packaged Codex does not expose CDP there');
  assert.match(serverSource, /function codexCdpPortCandidates/, 'backend can scan fallback CDP ports when the preferred port is poisoned');
  assert.match(functionBody('runCodexCdpLauncher'), /for \(const launchPort of codexCdpPortCandidates\(\)\)/, 'launcher tries fallback CDP ports instead of hard-failing on one bad port');
  assert.doesNotMatch(functionBody('runCodexCdpLauncher'), /-AllowIsolatedProfile/, 'control enablement must not open an isolated second Codex window');
  assert.match(serverSource, /function codexCdpUserDataDir/, 'launcher centralizes the controlled Codex profile path');
  assert.match(functionBody('codexCdpUserDataDir'), /codex-cdp-profile-\$\{launchPort\}/, 'launcher uses a stable profile per CDP port so control commands reuse the same Codex window');
  assert.doesNotMatch(functionBody('runCodexCdpLauncher'), /codex-cdp-profile-\$\{launchPort\}-\$\{Date\.now\(\)\}/, 'launcher must not create a fresh isolated Codex profile for every control command');
  assert.match(functionBody('runCodexCdpLauncher'), /const forceRestart = options\.forceRestart === true;/, 'manual control enablement honors the explicit force-restart request without an environment gate');
  assert.match(serverSource, /function writeCodexConfigStringValue/, 'backend can persist Codex config after live verification');
  assert.match(serverSource, /async function verifyCodexModelSwitch/, 'model switch verifier remains available for diagnostics');
  assert.match(serverSource, /async function trySwitchCodexModelViaConfig/, 'model switch can persist the selected model after GUI automation');
  assert.match(serverSource, /async function trySyncCodexModelViaExistingCdp/, 'model switch can sync an already-enabled Codex control window');
  assert.match(serverSource, /async function selectCodexModelViaCdp/, 'model switch has a menu-only CDP helper');
  const helperBody = functionBody('selectCodexModelViaCdp');
  assert.doesNotMatch(helperBody, /Input\.insertText|clickCodexSendButtonInCdpClient|sendTextViaCodexCdp/, 'model menu helper must not type or send messages');

  const switchBody = functionBody('switchCodexGuiModel');
  assert.match(switchBody, /trySyncCodexModelViaExistingCdp\(target\)/, 'model switch syncs the visible Codex client when control is already enabled');
  assert.match(switchBody, /trySwitchCodexModelViaConfig\(liveTargetModel \|\| target\)/, 'model switch persists config only after live verification');
  assert.doesNotMatch(switchBody, /focusTarget\('codex'/, 'model switch must not focus or open a new Codex client as a side effect');
  assert.doesNotMatch(switchBody, /sendTextViaCodexCdp\('\/模型'\)/, 'model switch must not send slash commands as tasks');
  assert.doesNotMatch(switchBody, /sendTextViaCodexCdp\(target\.displayName\)/, 'model switch must not send model labels as tasks');
  assert.doesNotMatch(switchBody, /copyTextToClipboard|pressPasteAndEnter/, 'model switch does not depend on clipboard paste into a pre-focused field');
  assert.match(functionBody('trySwitchCodexModelViaConfig'), /writeCodexConfigStringValue\('model'/, 'config model switch persists the Codex model setting');
  assert.doesNotMatch(functionBody('trySwitchCodexModelViaConfig'), /verifyCodexModelSwitch\(/, 'config model switch does not fail just because CDP/live session verification is unavailable');
  assert.match(functionBody('trySyncCodexModelViaExistingCdp'), /requireExistingCodexCdpTargetForSwitch\('model'\)/, 'live model sync requires an existing CDP client without auto-opening one');
  assert.match(functionBody('trySyncCodexModelViaExistingCdp'), /selectCodexModelViaCdp\(target\)/, 'live model sync selects the target from the real Codex menu');
  assert.match(functionBody('trySyncCodexModelViaExistingCdp'), /verifyCodexModelSwitch\('',\s*target,[\s\S]*domOnly:\s*true/, 'live model sync verifies the visible Codex DOM instead of stale session files');
  assert.match(functionBody('trySwitchCodexModelViaConfig'), /verifiedBy:\s*'config-write'/, 'config model switch reports a config-write confirmation');
  assert.match(switchBody, /writeControlOverride\('model'/, 'model switch records a status override immediately after persisting config');
  assert.match(serverSource, /CODEX_CDP_REQUIRED_FOR_SWITCH/, 'model switch fails honestly when the live Codex menu cannot be controlled');
  assert.match(switchBody, /const finalTargetModel = liveTargetModel/, 'model switch only reports a verified live sync as success');
  assert.match(switchBody, /targetModel:\s*\{\s*\.\.\.finalTargetModel/, 'model switch returns the confirmed target model');
});

test('reasoning switch verifies the live CDP client before reporting success', () => {
  assert.match(serverSource, /async function trySwitchCodexReasoningViaConfig/, 'reasoning switch can persist config after GUI automation');
  assert.match(serverSource, /async function trySyncCodexReasoningViaExistingCdp/, 'reasoning switch can sync an already-enabled Codex control window');
  assert.match(serverSource, /async function selectCodexReasoningModeViaCdp/, 'reasoning switch has a menu-only CDP helper');
  const helperBody = functionBody('selectCodexReasoningModeViaCdp');
  assert.doesNotMatch(helperBody, /Input\.insertText|clickCodexSendButtonInCdpClient|sendTextViaCodexCdp/, 'reasoning menu helper must not type or send messages');

  const switchBody = functionBody('switchCodexReasoningMode');
  assert.match(switchBody, /trySyncCodexReasoningViaExistingCdp\(target\)/, 'reasoning switch syncs the visible Codex client when control is already enabled');
  assert.match(switchBody, /trySwitchCodexReasoningViaConfig\(liveTargetReasoning \|\| target\)/, 'reasoning switch persists config only after live verification');
  assert.doesNotMatch(switchBody, /focusTarget\('codex'/, 'reasoning switch must not focus or open a new Codex client as a side effect');
  assert.match(functionBody('trySwitchCodexReasoningViaConfig'), /writeCodexConfigStringValue\('model_reasoning_effort'/, 'config reasoning switch persists the Codex reasoning setting');
  assert.doesNotMatch(functionBody('trySwitchCodexReasoningViaConfig'), /verifyCodexReasoningModeSwitch\(/, 'config reasoning switch does not require CDP/live verification');
  assert.match(functionBody('trySyncCodexReasoningViaExistingCdp'), /requireExistingCodexCdpTargetForSwitch\('reasoning'\)/, 'live reasoning sync requires an existing CDP client without auto-opening one');
  assert.match(functionBody('trySyncCodexReasoningViaExistingCdp'), /selectCodexReasoningModeViaCdp\(target\)/, 'live reasoning sync selects the target from the real Codex menu');
  assert.match(functionBody('trySyncCodexReasoningViaExistingCdp'), /verifyCodexReasoningModeSwitch\('',\s*target/, 'live reasoning sync verifies the visible Codex DOM');
  assert.match(functionBody('trySwitchCodexReasoningViaConfig'), /verifiedBy:\s*'config-write'/, 'config reasoning switch reports a config-write confirmation');
  assert.match(switchBody, /writeControlOverride\('reasoning'/, 'reasoning switch records a status override immediately after persisting config');
  assert.match(serverSource, /CODEX_CDP_REQUIRED_FOR_SWITCH/, 'reasoning switch fails honestly when the live Codex menu cannot be controlled');
  assert.doesNotMatch(switchBody, /sendTextViaCodexCdp\('\/推理模式'\)/, 'reasoning switch must not send slash commands as tasks');
  assert.doesNotMatch(switchBody, /sendTextViaCodexCdp\(target\.displayName\)/, 'reasoning switch must not send mode labels as tasks');
  assert.doesNotMatch(switchBody, /copyTextToClipboard|pressPasteAndEnter/, 'reasoning switch does not depend on clipboard paste into a pre-focused field');
});

test('speed switch uses the Codex submenu and never submits commands as tasks', () => {
  assert.match(serverSource, /const SPEED_MODE_TARGETS/, 'speed targets are defined');
  assert.match(serverSource, /async function selectCodexSpeedModeViaCdp/, 'speed switch has a menu-only CDP helper');
  assert.match(serverSource, /async function trySwitchCodexSpeedViaConfig/, 'speed switch can use the config-file path before GUI automation');
  assert.match(serverSource, /async function trySyncCodexSpeedViaExistingCdp/, 'speed switch can sync an already-enabled Codex control window');
  assert.match(serverSource, /async function switchCodexSpeedMode/, 'speed switch server action exists');
  assert.match(serverSource, /handleSpeedMode/, 'speed switch HTTP handler exists');
  assert.match(serverSource, /\/codex\/speed-mode/, 'speed switch route exists');

  const helperBody = functionBody('selectCodexSpeedModeViaCdp');
  assert.doesNotMatch(helperBody, /Input\.insertText|clickCodexSendButtonInCdpClient|sendTextViaCodexCdp/, 'speed menu helper must not type or send messages');

  const switchBody = functionBody('switchCodexSpeedMode');
  assert.match(switchBody, /trySyncCodexSpeedViaExistingCdp\(target\)/, 'speed switch syncs the visible Codex client when control is already enabled');
  assert.match(switchBody, /trySwitchCodexSpeedViaConfig\(liveTargetSpeed \|\| target\)/, 'speed switch persists config only after live verification');
  assert.doesNotMatch(switchBody, /focusTarget\('codex'/, 'speed switch must not focus or open a new Codex client as a side effect');
  assert.match(switchBody, /controlOverrideModel\(controlOverrides,\s*parsedModel\) \|\| configModel \|\| liveModel/, 'speed switch respects App/config model before stale live window data');
  assert.match(functionBody('trySwitchCodexSpeedViaConfig'), /writeCodexConfigStringValue\('service_tier'/, 'speed switch can use the real Codex service_tier config');
  assert.match(functionBody('trySwitchCodexSpeedViaConfig'), /verifiedBy\s*=\s*'config-write'/, 'speed config path is reported as a verified config write');
  assert.match(functionBody('trySyncCodexSpeedViaExistingCdp'), /requireExistingCodexCdpTargetForSwitch\('speed'\)/, 'live speed sync requires an existing CDP client without auto-opening one');
  assert.match(functionBody('trySyncCodexSpeedViaExistingCdp'), /selectCodexSpeedModeViaCdp\(target\)/, 'live speed sync selects the target from the real Codex speed submenu');
  assert.match(functionBody('trySyncCodexSpeedViaExistingCdp'), /verifiedBy:\s*'menu-selection'/, 'live speed sync confirms the real submenu selection before success');
  assert.match(functionBody('trySyncCodexSpeedViaExistingCdp'), /evidence:\s*selection\?\.selected\?\.text/, 'live speed sync keeps menu-selection evidence for diagnostics');
  assert.match(switchBody, /writeControlOverride\('speed'/, 'speed switch records a status override immediately after persisting config');
  assert.match(serverSource, /CODEX_CDP_REQUIRED_FOR_SWITCH/, 'speed switch fails honestly when the live Codex menu cannot be controlled');
  assert.doesNotMatch(switchBody, /sendTextViaCodexCdp/, 'speed switch must not send slash commands or labels as tasks');
  assert.doesNotMatch(switchBody, /copyTextToClipboard|pressPasteAndEnter/, 'speed switch does not depend on clipboard paste into a pre-focused field');
  assert.match(switchBody, /targetSpeedMode/, 'speed switch returns the confirmed target speed');
  assert.match(serverSource, /codexModelSupportsSpeed/, 'backend gates speed controls by model support');
  assert.match(functionBody('selectCodexComposerModeMenuItemViaCdp'), /focusSubmenuTrigger\('speed'\)/, 'speed switch can open the nested speed submenu with keyboard navigation');
  assert.match(serverSource, /高速/, 'speed switch recognizes the current Codex high-speed label');
  assert.match(functionBody('selectCodexSpeedModeViaCdp'), /1\.5x/, 'speed switch includes the current high-speed menu hint');
  assert.doesNotMatch(functionBody('speedModeFromMenuText'), /compact\.includes\('速度'\)/, 'speed parser keeps Codex labels like 标准默认速度 selectable');
  assert.match(functionBody('selectCodexComposerModeMenuItemViaCdp'), /speedTargetKeys/, 'speed switch normalizes speed targets before matching menu items');
  assert.match(functionBody('selectCodexComposerModeMenuItemViaCdp'), /speedModeFromMenuText\(text\)/, 'speed switch does not partially match the reasoning 高 item as 高速');
  assert.match(functionBody('codexModelSupportsSpeed'), /modelOptionUtils\.modelSupportsSpeed/, 'backend speed gate uses model catalog metadata before compatibility fallbacks');
  assert.match(switchBody, /SPEED_UNSUPPORTED_MODEL/, 'speed switch rejects models without a speed submenu');
  assert.match(webSource, /function modelSupportsSpeed/, 'web frontend derives speed support from the selected model');
  assert.match(functionBody('modelSupportsSpeed', webSource), /gpt55/, 'web speed gate accepts GPT5.5 names without a dot');
  assert.match(functionBody('modelSupportsSpeed', webSource), /gpt54/, 'web speed gate accepts GPT5.4 names without a dot');
  assert.match(webSource, /function updateSpeedSupportFromModel/, 'web frontend centralizes speed menu visibility updates');
  assert.match(webSource, /updateSpeedSupportFromModel\(data\.targetModel/, 'web frontend refreshes speed visibility after model switching');
  assert.match(webSource, /data\?\.targetModel \|\| data\?\.currentModel \|\| data\?\.model/, 'web frontend uses confirmed status model data before showing speed controls');
});

test('config and status expose complete Codex client state for mobile', () => {
  const configBody = functionBody('handleClientConfig');
  const handleStatusBody = functionBody('handleCodexStatus');
  const controlPortBody = functionBody('handleControlPort');
  assert.match(configBody, /reasoningOptions/, 'config exposes reasoning choices to the App');
  assert.match(configBody, /speedOptions/, 'config exposes speed choices to the App');
  assert.match(configBody, /refreshModes/, 'config refreshes live menu choices only when explicitly requested');
  assert.match(configBody, /cachedLiveModeOptions/, 'ordinary config reads use cached menu choices');
  assert.match(handleStatusBody, /cachedLiveModeOptions/, 'status polling uses cached menu choices');
  assert.doesNotMatch(handleStatusBody, /await\s+readLiveCodexModeOptions/, 'status polling must not open Codex mode menus');
  assert.match(controlPortBody, /readLiveCodexModeOptionsBounded\(\{\s*force:\s*true\s*\}\)/, 'explicit control-port setup refreshes live menu choices without blocking indefinitely');

  const catalogBody = functionBody('readModelCatalogOptions');
  assert.match(catalogBody, /models_cache\.json/, 'model options fall back to Codex desktop models_cache.json');

  const findBody = functionBody('findModelOption');
  assert.match(findBody, /displayName|label/, 'model switching accepts visible Codex model names');

  const statusBody = functionBody('parseCodexStatus');
  assert.doesNotMatch(statusBody, /steps\.slice\(-30\)/, 'status keeps all process steps for mobile expansion');
  assert.match(serverSource, /readLiveCodexComposerModeState/, 'backend can read the current Codex window mode state');
  assert.match(serverSource, /readLiveCodexModeOptions/, 'backend can read live Codex menu option lists');
  assert.match(serverSource, /function cachedLiveModeOptions/, 'backend keeps live menu choices available without opening menus during polling');
  assert.match(serverSource, /readCodexModeOptionsViaCdp/, 'backend discovers model, reasoning, and speed options from the real Codex menu');
  assert.match(functionBody('codexModeMenuItems'), /cmdkItem|radixItem/, 'live option discovery only accepts real menu collection items');
  assert.doesNotMatch(functionBody('codexModeMenuItems'), /item\.rect\.w < 40/, 'live option discovery does not absorb ordinary sidebar buttons by size');
  assert.match(statusBody, /liveModeState/, 'status can read live Codex window state when available');
  assert.match(statusBody, /liveModeOptions/, 'status returns live Codex menu options to mobile clients');
  assert.match(statusBody, /modelOptions/, 'status exposes live model choices');
  assert.match(statusBody, /speedOptions/, 'status exposes live speed choices');
  assert.match(serverSource, /resolveLiveSpeedOptions/, 'status/config merge the current speed with live speed menu choices');
  assert.match(functionBody('resolveLiveSpeedOptions'), /Object\.values\(SPEED_MODE_TARGETS\)/, 'speed options fall back to standard and fast without opening Codex menus');
  assert.match(statusBody, /liveModel,[\s\S]*overrideModel,[\s\S]*configModel/, 'status shows the real visible Codex client state before persisted fallback data');
  assert.match(statusBody, /configSpeedMode/, 'status falls back to config speed when the active session lacks speed metadata');
  assert.match(statusBody, /configReasoningMode/, 'status falls back to config reasoning when the active session lacks reasoning metadata');
  assert.match(serverSource, /async function readCodexComposerModeStateViaCdp/, 'backend reads the live mode button state as structured data');
  assert.match(functionBody('readCodexComposerModeStateViaCdp'), /data-model-selected/, 'live mode state reads the selected model attribute');
  assert.match(functionBody('readCodexComposerModeStateViaCdp'), /data-reasoning-selected/, 'live mode state reads the selected reasoning attribute');
  assert.match(functionBody('readCodexComposerModeStateViaCdp'), /data-speed-selected/, 'live mode state reads the selected speed attribute');
  assert.match(functionBody('readLiveCodexComposerModeState'), /readCodexComposerModeStateViaCdp/, 'status/config use structured live mode data instead of button text alone');
  assert.match(serverSource, /handleAttachment/, 'server exposes authenticated image attachments for mobile rendering');
  assert.match(configBody, /controlPort/, 'config explains the Codex control-port capability exposed by the backend');
});

test('manual control-port enablement force-restarts Codex into one controlled client', () => {
  assert.match(serverSource, /async function findRunningCodexCdpPorts/, 'backend can discover already-running Codex CDP ports');
  assert.match(functionBody('runCodexCdpLauncher'), /findRunningCodexCdpPorts\(\)/, 'launcher checks for an existing CDP process before scanning fallback ports');
  assert.match(functionBody('runCodexCdpLauncher'), /reused:\s*true/, 'launcher reports an existing ready CDP process as reused');
  assert.match(functionBody('runCodexCdpLauncher'), /CODEX_CDP_EXISTING_UNREADY/, 'launcher refuses to open a second Codex when an existing CDP process is still starting or unhealthy');
  assert.match(functionBody('ensureCodexCdpReady'), /launched:\s*launch\.launched !== false/, 'control-port response distinguishes reused clients from newly opened clients');
  assert.match(functionBody('handleControlPort'), /readLiveCodexModeOptionsBounded\(\{\s*force:\s*true\s*\}\)/, 'manual enablement does not block indefinitely on menu discovery');
  assert.match(serverSource, /CODEX_MODE_OPTIONS_REFRESH_TIMEOUT_MS/, 'live mode menu refresh has a bounded timeout');

  const startBody = launcherSource.slice(launcherSource.indexOf('private void StartCodexCdp()'));
  assert.match(startBody, /MessageBox\.Show\(/, 'manual enable button asks before restarting Codex');
  assert.match(startBody, /MessageBoxButtons\.OKCancel/, 'restart confirmation uses an explicit cancelable dialog');
  assert.match(startBody, /MessageBoxDefaultButton\.Button2/, 'cancel is the default to avoid stopping important Codex work accidentally');
  assert.match(startBody, /forceRestart\\?":true/, 'manual enable button requests a forced Codex restart after confirmation');
  assert.match(startBody, /allowIsolatedProfile\\?":false/, 'manual enable button never asks the backend to open an isolated second Codex window');
  const postStart = launcherSource.indexOf('private string PostLocalJson');
  assert.notEqual(postStart, -1, 'launcher PostLocalJson exists');
  const postBody = launcherSource.slice(postStart, launcherSource.indexOf('private string GetLocalJson', postStart));
  assert.match(postBody, /request\.Timeout\s*=\s*75000/, 'control-panel POST timeout covers CDP startup and bounded menu refresh');
  assert.match(postBody, /request\.ReadWriteTimeout\s*=\s*75000/, 'control-panel POST read timeout covers CDP startup and bounded menu refresh');

  assert.match(cdpLauncherSource, /function Get-CodexCdpProcessPorts/, 'PowerShell launcher can detect existing CDP Codex processes');
  assert.match(cdpLauncherSource, /Stop-CodexDesktopProcesses/, 'PowerShell launcher can close all existing Codex desktop processes for forced control setup');
  assert.match(cdpLauncherSource, /exit 4/, 'duplicate CDP refusal has a distinct exit code');
});

test('control panel startup warns when Codex control is not ready', () => {
  assert.match(launcherSource, /CheckCodexControlAfterStartup/, 'launcher checks Codex control readiness after backend startup');
  const checkBody = launcherSource.slice(launcherSource.indexOf('private void CheckCodexControlAfterStartup'));
  assert.match(checkBody, /\/codex\/config/, 'startup control check reads the backend config');
  assert.match(checkBody, /controlPort/, 'startup control check inspects the control-port status');
  assert.match(checkBody, /启用 Codex 控制|鍚敤 Codex 鎺у埗/, 'startup warning tells the user to click Enable Codex Control');
  assert.match(checkBody, /模型|妯″瀷/, 'startup warning explains model and parameter adjustment requires control mode');
});

test('passive config and status reads never auto-open or wait long on Codex CDP', () => {
  const liveStateBody = functionBody('readLiveCodexComposerModeState');
  assert.match(liveStateBody, /autoOpen:\s*false/, 'passive live state reads do not launch or restart Codex');
  assert.match(liveStateBody, /CODEX_CDP_PASSIVE_PROBE_TIMEOUT_MS/, 'passive live state target probing has a short timeout');
  assert.match(liveStateBody, /CODEX_CDP_PASSIVE_SEND_TIMEOUT_MS/, 'passive live state CDP calls have a short timeout');

  const stateViaCdpBody = functionBody('readCodexComposerModeStateViaCdp');
  assert.match(stateViaCdpBody, /findCodexCdpTarget\(\{[\s\S]*autoOpen:\s*options\.autoOpen/, 'structured mode reads pass the auto-open policy to target discovery');
  assert.match(stateViaCdpBody, /probeTimeoutMs:\s*options\.probeTimeoutMs/, 'structured mode reads pass the probe timeout to target discovery');
  assert.match(stateViaCdpBody, /connectCdpWebSocket\(target\.webSocketDebuggerUrl,\s*options\.timeoutMs/, 'structured mode reads bound CDP connection and send time');

  const socketBody = functionBody('connectCdpWebSocket');
  assert.match(socketBody, /const callTimer = setTimeout/, 'individual CDP calls have a timeout');
  assert.match(socketBody, /pending\.delete\(id\)/, 'timed-out CDP calls are removed from the pending map');
});

test('status parsing expands beyond the small tail for long active turns', () => {
  assert.match(serverSource, /function readStatusLinesAdaptive/, 'backend has adaptive status tail reading for long active turns');
  assert.match(functionBody('readStatusLinesAdaptive'), /CODEX_HISTORY_TAIL_BYTES/, 'status reader can expand to the larger history tail when markers are missing');
  assert.match(functionBody('readStatusLinesAdaptive'), /statusTailNeedsExpansion/, 'status reader checks whether the small tail lost the active turn boundary');
  assert.match(functionBody('parseCodexStatus'), /readStatusLinesAdaptive\(file,\s*\{\s*sinceMs\s*\}\)/, 'status parser uses adaptive lines instead of a fixed 5MB tail');
  assert.doesNotMatch(functionBody('parseCodexStatus'), /for \(const line of readTailLines\(file\)\)/, 'status parser no longer depends only on the fixed small tail');
});

test('process image tool calls carry renderable attachment URLs for mobile', () => {
  assert.match(serverSource, /function imageAttachmentsFromTool/, 'backend extracts image files from Codex image-related tool calls');
  assert.match(serverSource, /name === 'view_image'[\s\S]*imageAttachmentsFromTool/, 'view_image calls expose their path as a process image attachment');
  assert.match(functionBody('stepFromEvent'), /attachments:\s*summary\.attachments/, 'process steps keep image attachments alongside compact summaries');
  assert.match(serverSource, /function enrichStatusAttachments/, 'live status enriches process step attachments with mobile-accessible URLs');
  assert.match(functionBody('handleCodexStatus'), /enrichStatusAttachments\(parseCodexStatus/, 'status responses return renderable process image URLs');
  assert.match(functionBody('enrichHistoryAttachments'), /processSteps[\s\S]*enrichAttachmentList/, 'history progress cards enrich nested process image attachments');
  assert.match(serverSource, /function attachmentFilePath/, 'attachment enrichment can recover the original file path from older attachment URLs');
  assert.match(serverSource, /function inlineAttachmentDataUrl/, 'small local image attachments include a data URL fallback for native mobile Image rendering');
  assert.match(serverSource, /INLINE_ATTACHMENT_BYTES/, 'inline image data is capped to avoid unbounded status responses');
  assert.match(functionBody('enrichAttachmentList'), /url:\s*attachmentUrlFor\(req,\s*filePath\)/, 'attachment URLs are rewritten to the current request route for mobile clients');
  assert.match(serverSource, /function enrichAttachmentList\(attachments,\s*req,\s*options = \{\}\)/, 'attachment enrichment can tune payload size per endpoint');
  assert.match(functionBody('enrichAttachmentList'), /const inlineData = options\.inlineData !== false/, 'attachment enrichment keeps inline image fallback enabled by default');
  assert.match(functionBody('enrichAttachmentList'), /dataUrl:\s*inlineData \? \(attachment\.dataUrl \|\| inlineAttachmentDataUrl/, 'enriched attachments expose inline image data only when the endpoint allows it');
  assert.match(functionBody('enrichStatusAttachments'), /enrichAttachmentList\(step\.attachments,\s*req,\s*\{\s*inlineData:\s*false\s*\}\)/, 'live status process images avoid base64 inlining during frequent polling');
  assert.match(functionBody('enrichHistoryAttachments'), /enrichAttachmentList\(message\.attachments,\s*req,\s*\{\s*inlineData:\s*false\s*\}\)/, 'history top-level attachments avoid base64 inlining on long threads');
  assert.match(functionBody('enrichHistoryAttachments'), /enrichAttachmentList\(step\.attachments,\s*req,\s*\{\s*inlineData:\s*false\s*\}\)/, 'history process images avoid base64 inlining on long threads');
  assert.doesNotMatch(functionBody('enrichAttachmentList'), /url:\s*attachment\.url\s*\|\|/, 'stale localhost attachment URLs are not preserved');
  assert.match(serverSource, /function localImageFileExists/, 'local image attachments are validated before exposing them to mobile clients');
  assert.match(functionBody('imageAttachmentFromSource'), /if\s*\(!localImageFileExists\(source\)\)\s*return null/, 'image parsing does not treat whole shell commands ending in image paths as attachments');
});

test('status tool progress is summarized for mobile instead of leaking raw tool JSON', () => {
  const formatToolBody = functionBody('formatToolCall');
  assert.match(formatToolBody, /name === 'shell_command'/, 'Harmony status parser recognizes shell_command as a command tool');
  assert.match(formatToolBody, /CommandStepSummary/, 'command tool status is reduced to a typed summary object');

  const stepBody = functionBody('stepFromEvent');
  assert.match(stepBody, /summary\.kind/, 'tool steps expose compact summary metadata');

  const statusBody = functionBody('parseCodexStatus');
  assert.match(statusBody, /compactProcessText/, 'processText is generated from compact status summaries');
  assert.doesNotMatch(statusBody, /statusSteps\.map\(step => `\$\{step\.label/, 'processText does not concatenate raw step text');
});

test('Codex session output phases keep final answers out of folded process details', () => {
  const stepBody = functionBody('stepFromEvent');
  assert.match(
    stepBody,
    /payload\.type === 'agent_message'[\s\S]*payload\.phase === 'final_answer'[\s\S]*kind:\s*'final'/,
    'event agent_message final_answer is classified as final output'
  );
  assert.match(
    stepBody,
    /payload\.type === 'agent_message'[\s\S]*payload\.phase === 'commentary'[\s\S]*kind:\s*'thinking'/,
    'event agent_message commentary remains folded process narrative'
  );
  assert.doesNotMatch(
    stepBody,
    /payload\.type === 'agent_message' && payload\.message\)\s*\{\s*return \{ kind:\s*'thinking'/,
    'agent_message is not blindly folded without checking its phase'
  );
  assert.match(serverSource, /function truncateDisplayTextPreservingLines/, 'backend has a final-answer truncation helper that preserves Markdown lines');
  assert.match(stepBody, /truncateDisplayTextPreservingLines\(String\(payload\.message/, 'event final answers preserve Markdown line breaks');
  assert.match(stepBody, /truncateDisplayTextPreservingLines\(text/, 'response-item final answers preserve Markdown line breaks');
  assert.doesNotMatch(stepBody, /kind:\s*payload\.phase === 'final_answer' \? 'final'[\s\S]{0,120}truncateText\(text/, 'final answers are not line-collapsed through truncateText');
});

test('history responses include completed process cards with stable fold metadata', () => {
  const historyBody = functionBody('parseCodexThreadHistory');
  const handleHistoryBody = functionBody('handleThreadHistory');
  assert.match(historyBody, /currentTurn = \{[\s\S]*steps:\s*\[\]/, 'history tracks process steps per task turn');
  assert.match(historyBody, /stepFromEvent\(item\)/, 'history reuses the same Codex event classifier as live status');
  assert.match(historyBody, /kind:\s*'progress'/, 'history emits progress messages for completed turns');
  assert.match(historyBody, /processCollapsed:\s*true/, 'completed history progress is collapsed by default');
  assert.match(historyBody, /progressMessageIdForTurn/, 'history progress ids match live progress ids');
  assert.match(historyBody, /isProcessEchoMessage\(lastMessage,\s*currentTurn\.steps/, 'task_complete commentary echoes are not promoted to final replies');
  assert.match(handleHistoryBody, /invalidateCodexThreadListCache/, 'history refresh invalidates stale thread-list runtime cache');
  assert.match(serverSource, /const threadHistoryCache = new Map\(\)/, 'backend caches parsed history by session file signature');
  assert.match(historyBody, /fileCacheSignature\(fileStat\)/, 'history cache key follows the JSONL file size and mtime');
  assert.match(historyBody, /threadHistoryCache\.has\(cacheKey\)/, 'unchanged long histories are served from cache instead of reparsed');
  assert.match(historyBody, /boundedSet\(threadHistoryCache/, 'parsed history cache is bounded');
});

test('in-task user guidance stays as user history without splitting the active process turn', () => {
  const historyBody = functionBody('parseCodexThreadHistory');
  const countBody = functionBody('countCodexHistoryMessages');
  assert.match(serverSource, /function extractUserHistoryMessage/, 'user history extraction is centralized');
  assert.match(serverSource, /function isDuplicateAdjacentUserHistoryMessage/, 'duplicated Codex user history records are detected centrally');
  assert.match(
    historyBody,
    /extractUserHistoryMessage\(item\)[\s\S]*isDuplicateAdjacentUserHistoryMessage[\s\S]*messages\.push\(\{[\s\S]*role:\s*'user'[\s\S]*continue;/,
    'history preserves user guidance messages even when they arrive while a task is running'
  );
  assert.match(countBody, /extractUserHistoryMessage\(item\)/, 'adaptive history tail counting uses the same user-message extraction');
  assert.match(countBody, /isDuplicateAdjacentUserHistoryMessage/, 'adaptive history tail counting ignores duplicated user records');
  const userHistoryBody = functionBody('extractUserHistoryMessage');
  assert.match(userHistoryBody, /payload\.type === 'user_message'/, 'ordinary event user messages are included');
  assert.match(userHistoryBody, /payload\.type === 'message'[\s\S]*payload\.role === 'user'/, 'response-item user messages from goal or plan mode are included');
  assert.match(userHistoryBody, /extractMessageText\(payload\.content\)/, 'response-item user content arrays are converted to display text');
  assert.match(serverSource, /function extractGoalObjectiveText/, 'goal-mode internal context has a dedicated objective extractor');
  assert.match(userHistoryBody, /extractGoalObjectiveText\(rawText\)/, 'goal-mode user messages display only the real objective text');
  assert.doesNotMatch(userHistoryBody, /codex_internal_context[\s\S]*return text/, 'internal goal context is not returned as an ordinary user bubble');
  assert.doesNotMatch(
    historyBody,
    /extractUserHistoryMessage\(item\)[\s\S]{0,320}currentTurn\s*=\s*null/,
    'a user guidance event does not terminate the current Codex process turn'
  );
  assert.match(
    historyBody,
    /messages\.splice\(turn\.assistantIndex,\s*0,\s*progress\)[\s\S]*turn\.assistantIndex \+= 1/,
    'completed process details are inserted next to the final answer, after any in-task user guidance'
  );
});

test('thread fallback titles ignore Codex internal context records', () => {
  const firstUserBody = functionBody('findFirstCodexUserMessage');
  const titleBody = functionBody('titleFromCodexHistoryItem');
  const internalTitleBody = functionBody('isInternalCodexTitleText');
  const placeholderBody = functionBody('isPlaceholderThreadName');
  assert.match(firstUserBody, /titleFromCodexHistoryItem\(item\)/, 'thread title scanning uses the dedicated title filter');
  assert.match(titleBody, /payload\.type === 'user_message'/, 'ordinary event user messages can still become fallback titles');
  assert.match(titleBody, /payload\.role === 'user'/, 'safe response-item user messages can still become fallback titles');
  assert.match(titleBody, /isInternalCodexTitleText/, 'response-item user messages are filtered before becoming titles');
  assert.match(internalTitleBody, /environment_context\|turn_aborted\|codex_internal_context/, 'internal context and aborted-turn markers are rejected as thread titles');
  assert.match(placeholderBody, /isInternalCodexTitleText\(text\)/, 'internal titles already stored in the Codex index are treated as placeholders');
});

test('chat-mutating routes invalidate thread cache for realtime mobile state', () => {
  assert.match(functionBody('handleThreads'), /refresh'\) === '1'[\s\S]*invalidateCodexThreadListCache/, 'explicit thread refresh bypasses the short thread-list cache');
  assert.match(serverSource, /async function readCurrentCodexThreadSelectionViaCdp/, 'backend can read the current desktop thread through existing CDP without launching Codex');
  assert.match(serverSource, /CODEX_CURRENT_THREAD_CACHE_MS/, 'current desktop thread selection is cached briefly');
  assert.match(serverSource, /function normalizeCodexThreadId/, 'backend normalizes Codex desktop local-prefixed thread ids');
  assert.match(serverSource, /function findCodexThreadIdByVisibleText/, 'backend can fall back to matching visible chat text when the selected sidebar row is not marked active');
  assert.match(functionBody('normalizeCurrentThreadSelection'), /normalizeCodexThreadId\(value\.threadId\)/, 'current thread selection strips Codex local: prefixes before matching session files');
  assert.match(functionBody('normalizeCurrentThreadSelection'), /findCodexThreadIdByVisibleText\(preview\)/, 'current thread selection can resolve the active thread from the main chat content');
  assert.match(functionBody('readCurrentCodexThreadSelectionViaCdp'), /\^\(\?:local:\)\?\[a-f0-9\]/, 'desktop current-thread reader accepts current Codex local-prefixed sidebar ids');
  assert.match(functionBody('readCurrentCodexThreadSelectionViaCdp'), /document\.querySelector\('main'\)[\s\S]*preview/, 'desktop current-thread reader captures main chat text when the sidebar has no active marker');
  assert.match(functionBody('activateCodexThreadViaExistingCdp'), /normalizeThreadId\(el\.getAttribute\('data-app-action-sidebar-thread-id'\)\) === threadId/, 'CDP thread activation matches local-prefixed sidebar ids to stored thread ids');
  assert.match(functionBody('handleThreads'), /readCurrentCodexThreadSelection\(\{ force: forceRefresh \}\)/, 'threads endpoint refreshes current desktop thread selection');
  assert.match(functionBody('handleThreads'), /selectedThreadId[\s\S]*currentThreadId[\s\S]*currentThread[\s\S]*threads/, 'threads endpoint returns the current desktop thread id to mobile clients');
  assert.match(functionBody('listCodexThreads'), /includeThreadId[\s\S]*threads\.some\(item => item\.id === includeThreadId\)/, 'thread list keeps the current desktop thread even when it falls outside the limit');
  assert.match(functionBody('handleSend'), /invalidateCodexThreadListCache\(\)[\s\S]*watchSince[\s\S]*invalidateCodexThreadListCache\(\)[\s\S]*return json/, 'send invalidates thread cache before and after accepting a message');
  assert.match(functionBody('handleStopCodex'), /invalidateCodexThreadListCache\(\)[\s\S]*stopCodexResponse[\s\S]*invalidateCodexThreadListCache\(\)/, 'stop invalidates runtime cache around the stop command');
  assert.match(functionBody('handleSelectThread'), /invalidateCodexThreadListCache\(\)[\s\S]*activateCodexThread/, 'select-thread clears thread cache before activating Codex');
});

test('mode menu selection follows Codex nested model and speed menus', () => {
  const helperBody = functionBody('selectCodexComposerModeMenuItemViaCdp');
  const clickBody = functionBody('cdpClickRect');
  const closeBody = functionBody('closeCodexCdpMenus');
  assert.match(helperBody, /findSubmenuTriggerByText\(snapshot,\s*'模型'\)/, 'model switch explicitly opens the model submenu');
  assert.match(helperBody, /findSubmenuTriggerByText\(snapshot,\s*'速度'\)/, 'speed switch explicitly opens the speed submenu');
  assert.match(serverSource, /data-codex-intelligence-trigger/, 'mode menu selection targets Codex’s real intelligence control button');
  assert.match(serverSource, /Input\.dispatchMouseEvent/, 'mode menu selection uses CDP mouse events instead of synthetic DOM clicks');
  assert.match(serverSource, /CODEX_DANGEROUS_CLICK_BLOCKED/, 'CDP clicks refuse dangerous Codex controls such as stop/send/cancel');
  assert.match(clickBody, /assertSafeCdpClickTarget/, 'every CDP mouse click verifies the hit target before dispatching events');
  assert.match(serverSource, /async function assertCodexCdpIdleForControlAction/, 'non-stop control actions check whether Codex is currently running before sending keys');
  assert.match(closeBody, /assertCodexCdpIdleForControlAction/, 'closing Codex menus refuses to press Escape while a response is running');
  assert.match(functionBody('assertCodexCdpIdleForControlAction'), /CODEX_CONTROL_UNAVAILABLE_WHILE_RUNNING/, 'running-state guard reports a clear non-stop-control error instead of interrupting Codex');
  assert.doesNotMatch(helperBody, /dispatchEvent\(new PointerEvent|dispatchEvent\(new MouseEvent/, 'mode menu selection does not rely on synthetic DOM mouse events');
});
