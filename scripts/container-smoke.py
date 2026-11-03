"""Disposable local-daemon smoke only. Never targets Oracle or an inherited Docker context.

Usage: python3 scripts/container-smoke.py occ:local [arm64|amd64]
Creates a UUID project, generated credentials and temporary volumes; removes ONLY
those resources. No live messaging account or production credential is required.
"""
import json
import os
import platform
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

image = sys.argv[1] if len(sys.argv) > 1 else "occ:local"
expected_arch = sys.argv[2] if len(sys.argv) > 2 else None
root = Path(__file__).resolve().parent.parent
runtime_env = os.environ.copy()
for selector in ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]:
    runtime_env.pop(selector, None)
docker = ["docker", "--host=unix:///var/run/docker.sock"]
project = "occ-smoke-" + uuid.uuid4().hex[:10]
directory = Path(tempfile.mkdtemp(prefix="occ-smoke-"))
standalone = project + "-standalone"
probe = project + "-probe"
egress = project + "-probe-egress"


def run(args, data=None, check=True):
    result = subprocess.run(docker + args, input=data, text=True, capture_output=True, env=runtime_env, timeout=90)
    if check and result.returncode:
        # Never echo command arguments, auth material, or raw service logs.
        categories = [word for word in ["EACCES", "ENOENT", "permission denied", "Operation not permitted", "not found", "no such file", "Invalid", "must be", "failed to create", "invalid mount", "OCI runtime", "requires"] if word in result.stderr]
        for line in result.stderr.splitlines():
            if "invalid mount" in line:
                print("Docker mount diagnostic:", line[:600], file=sys.stderr)
        raise RuntimeError(f"Local Docker smoke failed (exit {result.returncode}; categories: {categories}); no raw logs/credentials displayed")
    return result


compose = ["compose", "--project-directory", str(directory), "--env-file", str(directory / ".env"),
           "-f", str(root / "docker-compose.yml"), "-p", project,
           "--profile", "monitoring", "--profile", "host-monitoring"]
try:
    arch = run(["image", "inspect", "-f", "{{.Architecture}}", image]).stdout.strip()
    if expected_arch and arch != expected_arch:
        raise RuntimeError("Image architecture is not the requested native test target")
    if expected_arch == 'arm64' and platform.machine().lower() not in ['arm64', 'aarch64']:
        raise RuntimeError('ARM64 smoke requires a native ARM64 runner, not only an ARM64 image manifest')
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        bind_port = listener.getsockname()[1]
    answers = {"bindPort": bind_port, "basePath": "/control/occ", "dockerMode": "proxy", "hostMonitoring": True}
    (directory / "answers.json").write_text(json.dumps(answers))
    (directory / "config/host-disk").mkdir(parents=True)
    run(["run", "--rm", "--network", "none", "--user", f"{os.getuid()}:{os.getgid()}",
         "--mount", f"type=bind,src={directory},dst=/work", "--workdir", "/work", image,
         "node", "/app/dist/src/operator/setup-cli.js", "answers.json"])
    with (directory / ".env").open("a") as output:
        output.write(f"\nOCC_IMAGE={image}\nOCC_DOCKER_GID={os.stat('/var/run/docker.sock').st_gid}\n")
    rendered = json.loads(run(compose + ["config", "--format", "json"]).stdout)
    services = rendered["services"]
    for name in ["telegram", "whatsapp"]:
        # Inactive profiles may be omitted from rendered output; query them explicitly below.
        full = json.loads(run(compose + ["--profile", name, "config", "--format", "json"]).stdout)["services"][name]
        assert set(full["networks"]) == {"gateway", "transport-egress"}
        assert not any("docker.sock" in str(v) for v in full.get("volumes", []))
    assert set(services["docker-monitor"]["networks"]) == {"docker-observe"}
    assert set(services["host-monitor"]["networks"]) == {"host-observe"}
    assert all(v.get("source") != "/" and v.get("source") != "/proc" for v in services["host-monitor"]["volumes"])
    assert services["core"]["ports"][0]["host_ip"] == "127.0.0.1"
    assert not any("docker.sock" in str(v) for v in services["core"].get("volumes", []))
    created = run(compose + ["run", "--rm", "--no-deps", "core", "node", "dist/src/admin.js"]).stdout
    password = created.split("Generated password (shown once; keep private): ")[1].strip()
    run(compose + ["run", "--rm", "--no-deps", "core", "node", "dist/src/operator/preflight-cli.js"])
    run(compose + ["up", "-d", "--no-build", "core", "docker-monitor", "host-monitor"])
    standalone_id = run(["run", "-d", "--name", standalone, "--network", "none", "--read-only", "--cap-drop", "ALL",
                         "--memory", "64m", image, "node", "-e", "setInterval(()=>{},30000)"]).stdout.strip()
    credentials = json.dumps({"username": "admin", "password": password})
    script = r"""
const assert = require('node:assert/strict');
let input='';for await (const part of process.stdin) input+=part;
const origin=process.env.OCC_PUBLIC_ORIGIN, base='http://127.0.0.1:3000'+process.env.OCC_BASE_PATH;
const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:input});
assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0], csrf=(await login.json()).data.csrf;
const headers={cookie,origin,'x-csrf-token':csrf,'content-type':'application/json'};
const system=(await (await fetch(base+'/api/v1/system',{headers})).json()).data;
assert.equal(system.host.available,true); assert.equal(system.host.metrics.scope,'host');
assert.equal(system.container.scope,'container/cgroup'); assert.equal(system.process.scope,'occ-process');
assert.ok(system.process.memoryRssBytes<384*1024*1024); assert.notEqual(process.getuid(),0);
const inventory=(await (await fetch(base+'/api/v1/containers',{headers})).json()).data;
assert.equal(inventory.available,true); assert.ok(inventory.containers.some(c=>c.composeProject===process.env.SMOKE_PROJECT));
assert.ok(inventory.containers.some(c=>c.id===process.env.SMOKE_STANDALONE&&c.composeProject===null));
const registration=await fetch(base+'/api/v1/projects',{method:'POST',headers,body:JSON.stringify({manifest:{protocolVersion:'1.0',id:'smoke-app',name:'Smoke',version:'1',runtime:'external'}})});
assert.ok([201,409].includes(registration.status));
const projects=(await (await fetch(base+'/api/v1/projects',{headers})).json()).data;assert.ok(projects.some(p=>p.id==='smoke-app'));
const page=await fetch(base+'/monitoring'); assert.match(await page.text(),/control\/occ\/assets/);
const baileys=await import('@whiskeysockets/baileys'); assert.equal(typeof baileys.useMultiFileAuthState,'function');
console.log(JSON.stringify({architecture:process.arch,hostSource:system.host.source,cgroupAvailable:system.container.available,rssMiB:Math.round(system.process.memoryRssBytes/1024/1024)}));
"""
    wrapped = "(async()=>{" + script + "})().catch(()=>{console.error('smoke request failed');process.exit(1)})"
    command = compose + ["exec", "-T", "-e", f"SMOKE_PROJECT={project}", "-e", f"SMOKE_STANDALONE={standalone_id}", "core", "node", "-e", wrapped]
    for attempt in range(25):
        result = run(command, credentials, check=False)
        if result.returncode == 0:
            print("PASS native image / scoped metrics / inventory / authenticated registry:", result.stdout.strip())
            break
        time.sleep(1)
    else:
        raise RuntimeError("Authenticated system/inventory smoke did not become ready")
    for service, target in [("docker-monitor", "docker"), ("host-monitor", "host")]:
        run(compose + ["exec", "-T", service, "node", "dist/src/services/collector-health.js", target])
    run(compose + ["exec", "-T", "core", "node", "dist/src/operator/preflight-cli.js", "--skip-port", "--probe-collectors"])
    run(compose + ["restart", "core"])
    time.sleep(2)
    assert run(command, credentials).returncode == 0  # User/project data survived the process restart.
    run(["network", "create", egress])
    run(["run", "-d", "--name", probe, "--network", f"{project}_gateway", "--read-only", "--cap-drop", "ALL", "--memory", "128m", image, "node", "-e", "setInterval(()=>{},30000)"])
    run(["network", "connect", egress, probe])
    for service, port in [("docker-monitor", 2375), ("host-monitor", 2376)]:
        container_id = run(compose + ["ps", "-q", service]).stdout.strip()
        networks = json.loads(run(["inspect", container_id]).stdout)[0]["NetworkSettings"]["Networks"]
        ip = next(iter(networks.values()))["IPAddress"]
        for host in [service, ip]:
            run(["exec", probe, "node", "-e", f"fetch('http://{host}:{port}/',{{signal:AbortSignal.timeout(1500)}}).then(()=>process.exit(1),()=>process.exit(0))"])
    print("PASS network boundary: worker-like gateway+egress container cannot reach either collector by DNS or IP")
    run(compose + ["--profile", "whatsapp", "run", "--rm", "--no-deps", "whatsapp", "node", "-e",
                   "const s=require('fs').statSync('/app/sessions/whatsapp');if((s.mode&511)!==448||process.getuid()===0)process.exit(1)"])
    print("PASS separate protected WhatsApp volume, collector health checks, persistent SQLite restart and low-memory core")
finally:
    for name in [probe, standalone]:
        run(["rm", "-f", name], check=False)
    # This unique project was created above by this script; no global prune/removal.
    run(compose + ["down", "--volumes", "--remove-orphans"], check=False)
    run(["network", "rm", egress], check=False)
    shutil.rmtree(directory)
