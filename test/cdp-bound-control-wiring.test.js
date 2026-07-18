'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server binds UI transactions and thread navigation to the verified CDP process', () => {
  assert.match(source, /createBoundCodexWindowDiscovery/);
  assert.match(source, /createCdpBoundThreadNavigator/);
  assert.match(source, /let codexCdpProcessId\s*=\s*0/);
  assert.match(source, /discoverWindow:\s*discoverControlledCodexWindow/);
  assert.match(source, /discoverWindow:\s*discoverSelectableCodexWindow/);
  assert.match(source, /fallbackWhenBoundMissing:\s*true/);
  assert.match(source, /readCurrentCodexThreadSelection\(\{ force: true \}\)\.catch\(\(\) => null\)/);
  assert.match(source, /codexCdpProcessId\s*=\s*controlledProcess\.processId/);
  assert.match(source, /reconcileCdpProcessBinding/);
  assert.match(source, /navigate:\s*async \(\{ threadId \}\) => cdpBoundThreadNavigator\(threadId\)/);
  assert.match(source, /navigateViaDeepLink:\s*threadId\s*=>\s*navigateCodexThreadViaDeepLink\(threadId\)/);
  assert.doesNotMatch(source, /navigate:\s*async \(\{ threadId \}\) => \{\s*return navigateCodexThreadViaDeepLink/);
});

test('control enable resolves the reachable dual-stack CDP target before binding its window owner', () => {
  assert.match(source, /let codexCdpHost\s*=\s*normalizeCdpProbeHost/);
  assert.match(source, /bindCdpTargetToProbeEndpoint/);
  const handlerStart = source.indexOf('async function runExplicitProcessControlHttpAction');
  const probe = source.indexOf('await probeCodexCdpTarget', handlerStart);
  const processScan = source.indexOf('await findRunningCodexCdpPorts', handlerStart);
  const reconciliation = source.indexOf('reconcileCdpProcessBinding', handlerStart);
  assert.ok(handlerStart >= 0 && probe > handlerStart);
  assert.ok(processScan > probe, 'process correlation uses the port selected by the reachable target probe');
  assert.ok(reconciliation > processScan, 'window binding follows target and process correlation');
});
