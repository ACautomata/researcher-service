import Docker from 'dockerode'
import { DockerPrimitives } from '../backend/dockerPrimitives'

export interface ProcessSpec {
  id: string
  container: string
  command: string
  hardTimeoutMs: number
  logBytes: number
}
export interface ProcessSnapshot {
  state: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted'
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
}
export interface BackgroundRuntime {
  start(spec: ProcessSpec): Promise<void>
  read(spec: ProcessSpec): Promise<ProcessSnapshot>
  cancel(spec: ProcessSpec): Promise<void>
}

// Commands are argv data, never interpolated into the supervisor source. All paths use
// a server-generated hex id. mkdir is the durable launch fence across controller replay.
export const SUPERVISOR = `
set -eu
d="$1"; budget="$2"; cap="$3"; command="$4"; cwd="$PWD"
mkdir -p /tmp/.researcher-exec
mkdir "$d" 2>/dev/null || exit 0
cd "$d"
echo "$5" > generation
echo "$$" > supervisor
mkfifo out.pipe err.pipe
(head -c "$cap" > stdout; cat > /dev/null) < out.pipe & out_reader=$!
(head -c "$cap" > stderr; cat > /dev/null) < err.pipe & err_reader=$!
setsid sh -c 'cd "$1" || exit 1; exec sh -c "$2"' sh "$cwd" "$command" > out.pipe 2> err.pipe & child=$!
echo "$child" > pid
if [ -f reason ]; then kill -KILL -- "-$child" 2>/dev/null || true; fi
(
  sleep "$budget" & sleeper=$!
  trap 'kill "$sleeper" 2>/dev/null || true; exit 0' TERM
  wait "$sleeper"
  echo timed_out > reason
  kill -KILL -- "-$child" 2>/dev/null || true
) & watchdog=$!
set +e
wait "$child"; code=$?
kill "$watchdog" 2>/dev/null
wait "$watchdog" 2>/dev/null
# Stop children left behind by a shell that exits before them; no orphan writers.
kill -KILL -- "-$child" 2>/dev/null
wait "$out_reader"; wait "$err_reader"
echo "$code" > exit.tmp
mv exit.tmp exit
rm -f out.pipe err.pipe
`

function path(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid background task id')
  return `/tmp/.researcher-exec/${id}`
}

export class DockerBackgroundRuntime implements BackgroundRuntime {
  constructor(private readonly docker = new Docker({ timeout: 10_000 }), private readonly primitives = new DockerPrimitives(() => docker)) {}

  async start(spec: ProcessSpec): Promise<void> {
    // setsid/head/mkfifo are part of the busybox sandbox contract. Fail before launch
    // if the configured image cannot provide process-group cancellation.
    const probe = await this.primitives.exec(spec.container, ['sh', '-c', 'command -v setsid && command -v head && command -v mkfifo'], { timeoutMs: 10_000 })
    if (probe.exitCode !== 0) throw new Error('Sandbox requires setsid, head and mkfifo for background exec')
    const generation = (await this.docker.getContainer(spec.container).inspect()).State.StartedAt
    const exec = await this.docker.getContainer(spec.container).exec({
      Cmd: ['sh', '-c', SUPERVISOR, 'background-exec', path(spec.id), String(Math.ceil(spec.hardTimeoutMs / 1000)), String(Math.floor(spec.logBytes / 2)), spec.command, generation],
      AttachStdout: false, AttachStderr: false,
    })
    await exec.start({ Detach: true })
  }

  async read(spec: ProcessSpec): Promise<ProcessSnapshot> {
    const info = await this.docker.getContainer(spec.container).inspect().catch((e: { statusCode?: number }) => {
      if (e.statusCode === 404) return null
      throw e
    })
    if (!info?.State.Running) return { state: 'interrupted', exitCode: null, stdout: '', stderr: 'Sandbox stopped', truncated: false }
    const result = await this.primitives.exec(spec.container, ['sh', '-c', `
cd "$1" 2>/dev/null || { printf 'missing\\n'; exit; }
if [ -f exit ]; then head -c 32 exit; elif [ -f generation ] && [ "$(cat generation)" != "$2" ]; then echo missing; elif [ -f supervisor ] && kill -0 "$(cat supervisor)" 2>/dev/null; then echo running; else echo missing; fi
head -c 32 reason 2>/dev/null || true
`, 'sh', path(spec.id), info.State.StartedAt], { timeoutMs: 10_000 })
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Cannot inspect background process')
    const [status, reason] = result.stdout.trim().split('\n')
    const readLog = async (name: string) => {
      const r = await this.primitives.exec(spec.container, ['sh', '-c', 'test ! -f "$1" || head -c "$2" "$1"', 'sh', `${path(spec.id)}/${name}`, String(Math.floor(spec.logBytes / 2))], { timeoutMs: 10_000 })
      if (r.exitCode !== 0) throw new Error('Cannot read background output')
      return r.stdout
    }
    const stdout = await readLog('stdout')
    const stderr = await readLog('stderr')
    const exitCode = /^\d+$/.test(status ?? '') ? Number(status) : null
    return {
      state: status === 'running' ? 'running' : status === 'missing' ? 'interrupted'
        : reason === 'cancelled' ? 'cancelled' : reason === 'timed_out' ? 'timed_out'
          : exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: reason === 'timed_out' ? 124 : exitCode, stdout, stderr,
      truncated: Buffer.byteLength(stdout) >= spec.logBytes / 2 || Buffer.byteLength(stderr) >= spec.logBytes / 2,
    }
  }

  async cancel(spec: ProcessSpec): Promise<void> {
    const info = await this.docker.getContainer(spec.container).inspect().catch((e: { statusCode?: number }) => {
      if (e.statusCode === 404) return null
      throw e
    })
    if (!info?.State.Running) return
    const r = await this.primitives.exec(spec.container, ['sh', '-c', `
mkdir -p "$1"
cd "$1"
[ -f generation ] && [ "$(cat generation)" != "$2" ] && exit 0
[ -f exit ] && exit 0
echo cancelled > reason
if [ -f pid ]; then kill -KILL -- "-$(cat pid)" 2>/dev/null || true; fi
`, 'sh', path(spec.id), info.State.StartedAt], { timeoutMs: 10_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr || 'Cannot cancel background process')
  }
}
