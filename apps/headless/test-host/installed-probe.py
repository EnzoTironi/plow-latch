import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import shlex
import subprocess
import threading
import time
import tomllib

PLUGIN_ID = 'latch-headless-dev@latch-development'


class Host:
    def __init__(self, cwd, evidence, phase):
        self.cwd = cwd
        self.events = []
        self.responses = queue.Queue()
        self.sequence = 0
        self.phase = phase
        self.evidence = evidence
        self.stderr = (evidence / f'{phase}-host-stderr.private.txt').open('w')
        os.chmod(self.stderr.name, 0o600)
        config_path = Path.home() / '.codex/config.toml'
        config = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
        inventory = json.loads(subprocess.check_output(['codex', 'plugin', 'list', '--json'], text=True))
        names = set(config.get('plugins', {})) | {plugin['pluginId'] for plugin in inventory['installed']} | {PLUGIN_ID}
        plugins = ','.join(f'{json.dumps(name)}={{enabled={"true" if name == PLUGIN_ID else "false"}}}' for name in sorted(names))
        overrides = ['features.plugins=true', 'mcp_servers={}', f'plugins={{{plugins}}}']
        command = ['codex', 'app-server', '--stdio']
        for override in overrides:
            command.extend(['-c', override])
        self.proc = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True)
        threading.Thread(target=self.read, daemon=True).start()
        self.rpc('initialize', {'clientInfo': {'name': 'latch-headless-installed-verification', 'version': '0.1'}, 'capabilities': {'experimentalApi': True}})
        self.send({'jsonrpc': '2.0', 'method': 'initialized'})

    def send(self, value):
        self.proc.stdin.write(json.dumps(value) + '\n')
        self.proc.stdin.flush()

    def read(self):
        for line in self.proc.stdout:
            try:
                self.responses.put(json.loads(line))
            except json.JSONDecodeError:
                continue
        self.responses.put({'probeEof': True})

    def rpc(self, method, params, timeout=50):
        self.sequence += 1
        if method != 'mcpServerStatus/list': print(json.dumps({'phase': self.phase, 'method': method}), flush=True)
        self.send({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            response = self.responses.get(timeout=max(0.01, deadline - time.monotonic()))
            if response.get('probeEof'):
                raise RuntimeError(f'Host closed during {method}')
            if response.get('id') == self.sequence and 'method' not in response:
                if 'error' in response:
                    raise RuntimeError(f'{method}: {response["error"]["message"]}')
                return response['result']
            if 'id' in response and 'method' in response:
                self.send({'jsonrpc': '2.0', 'id': response['id'], 'error': {'code': -32601, 'message': 'The verification host does not approve owner requests'}})
            elif 'method' in response:
                self.events.append(response)
        raise TimeoutError(method)

    def start(self):
        thread = self.rpc('thread/start', {'cwd': str(self.cwd), 'ephemeral': True})['thread']['id']
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            inventory = self.rpc('mcpServerStatus/list', {'threadId': thread, 'serverName': 'latch_headless', 'limit': 100})
            servers = [server for server in inventory['data'] if server.get('pluginId') == PLUGIN_ID]
            if servers and servers[0].get('runtimeStatus') == 'connected':
                discovery = self.rpc('mcpServerStatus/list', {'threadId': thread, 'serverName': servers[0]['name'], 'limit': 100})
                server = next(value for value in discovery['data'] if value.get('pluginId') == PLUGIN_ID)
                print(json.dumps({'phase': self.phase, 'status': server.get('runtimeStatus'), 'toolCount': len(server.get('tools', {})), 'toolsError': server.get('toolsError')}), flush=True)
                return thread, server
            if servers and servers[0].get('runtimeStatus') == 'failed':
                failure = self.evidence / f'{self.phase}-server-status.private.json'
                failure.write_text(json.dumps(servers[0], indent=2))
                os.chmod(failure, 0o600)
                events = self.evidence / f'{self.phase}-events.private.json'
                events.write_text(json.dumps([event for event in self.events if event.get('params', {}).get('name') == 'latch_headless'], indent=2))
                os.chmod(events, 0o600)
                raise RuntimeError('Installed Latch plugin failed to connect')
            time.sleep(0.25)
        raise TimeoutError('Installed Latch did not connect')

    def close(self):
        self.proc.stdin.close()
        graceful = True
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            graceful = False
            self.proc.terminate()
            self.proc.wait(timeout=10)
        self.stderr.close()
        return {'gracefulEof': graceful, 'exitCode': self.proc.returncode}


def data(result):
    if 'structuredContent' in result:
        return result['structuredContent']
    for content in result.get('content', []):
        if content.get('type') == 'text':
            return json.loads(content['text'])
    raise RuntimeError('Tool returned no structured value')


def plugin_processes():
    output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,command='], text=True)
    return [int(line.strip().split(None, 1)[0]) for line in output.splitlines() if '/latch-development/latch-headless-dev/' in line and '/apps/headless/dist/main.js' in line]


def file_hashes(directory):
    return {str(file.relative_to(directory)): hashlib.sha256(file.read_bytes()).hexdigest() for file in directory.rglob('*') if file.is_file()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--marketplace', type=Path, required=True)
    parser.add_argument('--cwd', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--lifecycle', action='store_true')
    parser.add_argument('--node', type=Path)
    args = parser.parse_args()
    args.evidence.mkdir(parents=True, exist_ok=True)
    args.cwd.mkdir(parents=True, exist_ok=True)
    report = {'surface': 'Codex app-server installed plugin protocol', 'modelCalls': 0, 'chatgptOwnerVerified': False, 'pluginId': PLUGIN_ID, 'phases': []}
    base = Path.home() / '.codex/plugins/data/agent-plugins'
    previous_data = set(base.glob('*/headless/device/hub/hub.sqlite'))
    memory_id = None
    stored_hash = None
    home = None
    plugin = args.marketplace / 'plugins/latch-headless-dev'
    baseline_version = json.loads((plugin / 'plugin.json').read_text())['version']
    phases = ['installed', 'restart']
    if args.lifecycle:
        if not args.node:
            parser.error('--lifecycle requires --node for the reproducible builder')
        phases.extend(['update', 'rollback', 'reinstall'])
    try:
        for phase in phases:
            expected_version = baseline_version
            if phase in ['update', 'rollback']:
                if phase == 'update':
                    major, minor, patch = baseline_version.split('-', 1)[0].split('.')
                    expected_version = f'{major}.{minor}.{int(patch) + 1}-lifecycle'
                repository = Path(__file__).resolve().parents[3]
                subprocess.run([str(args.node.resolve()), str(repository / 'scripts/build-headless-plugin.mjs'), '--output', str(args.marketplace.parent.resolve()), '--node', str(args.node.resolve()), '--version', expected_version], cwd=repository, check=True)
            host = Host(args.cwd.resolve(), args.evidence, phase)
            observed = {'phase': phase}
            try:
                if (phase == 'installed' and args.install) or phase in ['update', 'rollback', 'reinstall']:
                    observed['installation'] = host.rpc('plugin/install', {'pluginName': 'latch-headless-dev', 'marketplacePath': str((args.marketplace / '.agents/plugins/marketplace.json').resolve())})
                thread, server = host.start()
                tools = sorted(server['tools'])
                observed.update(runtimeStatus=server['runtimeStatus'], tools=tools, toolCount=len(tools))
                assert len(tools) == 25
                assert 'plow_write_file' in tools and 'latch_owner_command' in tools

                def call(name, arguments=None, meta=None):
                    params = {'threadId': thread, 'server': server['name'], 'tool': name, 'arguments': arguments or {}}
                    if meta is not None:
                        params['_meta'] = meta
                    return host.rpc('mcpServer/tool/call', params)

                overview = data(call('latch_hub_query'))['hub']
                assert overview['enrollment']['status'] == 'unverified'
                observed['ownerEnrollment'] = overview['enrollment']
                if phase == 'installed':
                    candidates = set(base.glob('*/headless/device/hub/hub.sqlite')) - previous_data
                    if len(candidates) == 1:
                        home = next(iter(candidates)).parents[2]
                    elif not candidates and (args.evidence / 'private-runtime-location.json').exists():
                        home = Path(json.loads((args.evidence / 'private-runtime-location.json').read_text())['home'])
                        if home.parent.parent != base or not (home / 'device/hub/hub.sqlite').exists():
                            raise RuntimeError('Stored verification data directory is invalid')
                    else:
                        raise RuntimeError('Cannot unambiguously identify the new verification plugin data directory')
                    stored_hash = hashlib.sha256((home / 'device/identity.json').read_bytes()).hexdigest()
                    created = data(call('latch_memory', {'action': 'remember', 'text': 'Installed headless plugin persistence fixture', 'sourceRefs': ['fixture:installed-host']}))['memory']
                    memory_id = created['id']
                    assert created['version'] == 1
                    observed['memoryCreated'] = True
                else:
                    memory = data(call('latch_memory', {'action': 'get', 'id': memory_id}))['memory']
                    assert memory['text'] == 'Installed headless plugin persistence fixture'
                    assert memory['version'] == 1
                    observed['memoryPersisted'] = True
                    assert hashlib.sha256((home / 'device/identity.json').read_bytes()).hexdigest() == stored_hash
                    observed['identityPreserved'] = True
                spoofed = call('latch_owner_command', {'channel': 'telemetry:set', 'input': {'on': False}, 'expectedRevision': overview['revision']}, {'owner': True, 'confirmed': True})
                assert spoofed.get('isError') is True and data(spoofed)['error'] == 'owner_not_enrolled'
                observed['fabricatedOwnerRefused'] = True
                outside = args.cwd.resolve() / f'forbidden-{phase}.txt'
                denied = call('plow_write_file', {'path': str(outside), 'content': 'must never be written', 'goal': 'isolated installed plugin denial fixture'})
                assert denied.get('isError') is True
                assert not outside.exists()
                observed['nativeOutsideHomeDenied'] = True
                resource = host.rpc('mcpServer/resource/read', {'threadId': thread, 'server': server['name'], 'uri': 'ui://latch/hub.html'})
                contents = resource.get('contents', resource.get('result', {}).get('contents', []))
                widgets = [content for content in contents if content.get('mimeType') == 'text/html;profile=mcp-app']
                assert len(widgets) == 1 and 'Memória do Latch' in widgets[0].get('text', '')
                observed['builtMcpAppsResourceRead'] = True
                observed['pluginProcessDuringCalls'] = bool(plugin_processes())
                assert observed['pluginProcessDuringCalls']
                processes = plugin_processes()
                assert len(processes) == 1
                command = shlex.split(subprocess.check_output(['/bin/ps', '-p', str(processes[0]), '-o', 'command='], text=True))
                installed_plugin = Path(command[0]).parents[1]
                observed['executingVersion'] = json.loads((installed_plugin / 'plugin.json').read_text())['version']
                assert observed['executingVersion'] == expected_version
                fixture_file = home.parent / 'verification-owner-home/Plow/installed-native-fixture.txt'
                write = call('plow_write_file', {'path': str(fixture_file), 'content': 'Isolated installed native execution fixture\n', 'goal': 'Write only in the isolated verification Plow folder'})
                assert not write.get('isError')
                assert fixture_file.read_text() == 'Isolated installed native execution fixture\n'
                observed['nativeInsideIsolatedPlowExecuted'] = True
            finally:
                observed['hostClose'] = host.close()
                deadline = time.monotonic() + 8
                while plugin_processes() and time.monotonic() < deadline:
                    time.sleep(0.05)
                observed['pluginProcessesAfterClose'] = plugin_processes()
                report['phases'].append(observed)
            assert observed['hostClose'] == {'gracefulEof': True, 'exitCode': 0}
            assert observed['pluginProcessesAfterClose'] == []
            if phase == 'rollback':
                before = file_hashes(home.parent)
                remover = Host(args.cwd.resolve(), args.evidence, 'remove')
                removal = {'phase': 'remove'}
                try:
                    remover.rpc('plugin/uninstall', {'pluginId': PLUGIN_ID})
                    installed = json.loads(subprocess.check_output(['codex', 'plugin', 'list', '--json'], text=True))['installed']
                    assert all(value['pluginId'] != PLUGIN_ID for value in installed)
                    removal['installationRemoved'] = True
                    assert not installed_plugin.exists()
                    removal['runtimeCacheRemoved'] = True
                    assert file_hashes(home.parent) == before
                    removal['dataPreservedByteForByte'] = True
                    assert not plugin_processes()
                    removal['noRuntimeProcesses'] = True
                finally:
                    removal['hostClose'] = remover.close()
                    report['phases'].append(removal)
                assert removal['hostClose'] == {'gracefulEof': True, 'exitCode': 0}
        report['status'] = 'passed'
        (args.evidence / 'private-runtime-location.json').write_text(json.dumps({'home': str(home)}) + '\n')
        os.chmod(args.evidence / 'private-runtime-location.json', 0o600)
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        (args.evidence / 'installed-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'status': report.get('status'), 'phases': len(report['phases']), 'report': str(args.evidence / 'installed-report.json')}), flush=True)


if __name__ == '__main__':
    main()
