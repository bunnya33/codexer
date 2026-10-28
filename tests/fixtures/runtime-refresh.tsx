import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RuntimeRefresh} from '../../apps/mobile/src/runtime-refresh';
import {relay} from '../../apps/mobile/src/relay';

const mode = new URLSearchParams(window.location.search).get('mode');
function Fixture() {
  const [calls, setCalls] = useState<unknown[]>([]);
  relay.sendCommand = async (deviceId, payload) => {
    setCalls(value => [...value, {deviceId, payload}]);
    return {commandId: 'command', deviceId, status: mode === 'failure' ? 'failed' : 'succeeded', code: 'runtime-refresh-accepted', result: {runtimeRefresh: mode === 'deferred' ? 'deferred' : mode === 'unknown' ? 'unknown' : 'refreshed'}};
  };
  return <><div data-testid="calls">{JSON.stringify(calls)}</div><RuntimeRefresh device={{id: 'chosen-device', name: 'Chosen PC', online: mode !== 'offline', runtimeRefresh: mode !== 'old'}}/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
