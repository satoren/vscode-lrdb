import {
  DebugSession,
  InitializedEvent,
  TerminatedEvent,
  ContinuedEvent,
  StoppedEvent,
  OutputEvent,
  Thread,
  StackFrame,
  Scope,
  Source,
  Handles,
  Breakpoint,
} from 'vscode-debugadapter'
import { DebugProtocol } from 'vscode-debugprotocol'
import { readFileSync, existsSync } from 'fs'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import { LuaWasm, LRDBAdapter, LRDBClient } from 'lrdb-debuggable-lua'

export interface LaunchRequestArguments
  extends DebugProtocol.LaunchRequestArguments {
  program: string
  args: string[]
  cwd: string

  useInternalLua?: boolean
  port: number
  sourceRoot?: string | string[]
  stopOnEntry?: boolean
}

export interface AttachRequestArguments
  extends DebugProtocol.AttachRequestArguments {
  host: string
  port: number
  sourceRoot: string | string[]

  stopOnEntry?: boolean
}

type GetLocalVariableParam = {
  type: 'get_local_variable'
  params: Parameters<LRDBClient.Client['getLocalVariable']>[0]
}
type GetGlobalParam = {
  type: 'get_global'
  params: Parameters<LRDBClient.Client['getGlobal']>[0]
}
type GetUpvaluesParam = {
  type: 'get_upvalues'
  params: Parameters<LRDBClient.Client['getUpvalues']>[0]
}
type EvalParam = {
  type: 'eval'
  params: Parameters<LRDBClient.Client['eval']>[0]
}

type VariableReference =
  | GetLocalVariableParam
  | GetGlobalParam
  | GetUpvaluesParam
  | EvalParam


  function stringify(value: unknown): string {
    if (value == null) {
      return 'nil'
    } else if (value == undefined) {
      return 'none'
    } else {
      return JSON.stringify(value)
    }
  }

export class LuaDebugSession extends DebugSession {
  // Lua
  private static THREAD_ID = 1

  private _debug_server_process: ChildProcess

  private _debug_client: LRDBClient.Client

  // maps from sourceFile to array of Breakpoints
  private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>()

  private _breakPointID = 1000

  private _variableHandles = new Handles<VariableReference>()

  private _sourceHandles = new Handles<string>()

  private _stopOnEntry: boolean

  /**
   * Creates a new debug adapter that is used for one debug session.
   * We configure the default implementation of a debug adapter here.
   */
  public constructor() {
    super()

    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false)
    this.setDebuggerColumnsStartAt1(false)
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
   // args: DebugProtocol.InitializeRequestArguments
  ): void {
    if (this._debug_server_process) {
      this._debug_server_process.kill()
      delete this._debug_server_process
    }
    if (this._debug_client) {
      this._debug_client.end()
      delete this._debug_client
    }
    // This debug adapter implements the configurationDoneRequest.
    response.body.supportsConfigurationDoneRequest = true

    response.body.supportsConditionalBreakpoints = true

    response.body.supportsHitConditionalBreakpoints = true

    // make VS Code to use 'evaluate' when hovering over source
    response.body.supportsEvaluateForHovers = true

    this.sendResponse(response)
  }

  private setupSourceEnv(sourceRoot: string[]) {
    this.convertClientLineToDebugger = (line: number): number => {
      return line
    }
    this.convertDebuggerLineToClient = (line: number): number => {
      return line
    }

    this.convertClientPathToDebugger = (clientPath: string): string => {
      for (let index = 0; index < sourceRoot.length; index++) {
        const root = sourceRoot[index]
        const resolvedRoot = path.resolve(root)
        const resolvedClient = path.resolve(clientPath)
        if (resolvedClient.startsWith(resolvedRoot)) {
          return path.relative(resolvedRoot, resolvedClient)
        }
      }
      return path.relative(sourceRoot[0], clientPath)
    }
    this.convertDebuggerPathToClient = (debuggerPath: string): string => {
      if (!debuggerPath.startsWith('@')) {
        return ''
      }
      const filename: string = debuggerPath.substr(1)
      if (path.isAbsolute(filename)) {
        return filename
      } else {
        if (sourceRoot.length > 1) {
          for (let index = 0; index < sourceRoot.length; index++) {
            const absolutePath = path.join(sourceRoot[index], filename)
            if (existsSync(absolutePath)) {
              return absolutePath
            }
          }
        }
        return path.join(sourceRoot[0], filename)
      }
    }
  }

  protected launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): void {
    this._stopOnEntry = args.stopOnEntry
    const cwd = args.cwd ? args.cwd : process.cwd()
    let sourceRoot = args.sourceRoot ? args.sourceRoot : cwd

    if (typeof sourceRoot === 'string') {
      sourceRoot = [sourceRoot]
    }

    this.setupSourceEnv(sourceRoot)
    const programArg = args.args ? args.args : []

    const port = args.port ? args.port : 21110

    const useInternalLua =
      args.useInternalLua != null
        ? args.useInternalLua
        : args.program.endsWith('.lua')

    if (useInternalLua) {
      const program = this.convertClientPathToDebugger(args.program)
      this._debug_server_process = LuaWasm.run(program, programArg, {
        cwd: cwd,
        silent: true,
      })
      this._debug_client = new LRDBClient.Client(
        new LRDBAdapter.ChildProcessAdapter(this._debug_server_process)
      )
    } else {
      this._debug_server_process = spawn(args.program, programArg, {
        cwd: cwd,
      })
      this._debug_client = new LRDBClient.Client(
        new LRDBAdapter.TcpAdapter(port, 'localhost')
      )
    }

    this._debug_client.onNotify.on((event) => {
      this.handleServerEvents(event)
    })
    ///    this._debug_client.on_close = () => {};
    //    this._debug_client.on_error = (e: any) => {};

    this._debug_client.onOpen.on(() => {
      this.sendEvent(new InitializedEvent())
    })

    this._debug_server_process.stdout.on('data', (data) => {
      this.sendEvent(new OutputEvent(data.toString(), 'stdout'))
    })
    this._debug_server_process.stderr.on('data', (data) => {
      this.sendEvent(new OutputEvent(data.toString(), 'stderr'))
    })
    this._debug_server_process.on('error', (msg: string) => {
      this.sendEvent(new OutputEvent(msg, 'error'))
    })
    this._debug_server_process.on('close', (code: number) => {
      this.sendEvent(new OutputEvent(`exit status: ${code}\n`))
      this.sendEvent(new TerminatedEvent())
    })

    this.sendResponse(response)
  }

  protected attachRequest(
    response: DebugProtocol.AttachResponse,
    oargs: DebugProtocol.AttachRequestArguments
  ): void {
    const args = oargs as AttachRequestArguments
    this._stopOnEntry = args.stopOnEntry
    let sourceRoot = args.sourceRoot

    if (typeof sourceRoot === 'string') {
      sourceRoot = [sourceRoot]
    }

    this.setupSourceEnv(sourceRoot)

    this._debug_client = new LRDBClient.Client(
      new LRDBAdapter.TcpAdapter(args.port, args.host)
    )

    this._debug_client.onNotify.on((event) => {
      this.handleServerEvents(event)
    })
    this._debug_client.onClose.on(() => {
      this.sendEvent(new TerminatedEvent())
    })
    this._debug_client.onOpen.on(() => {
      this.sendEvent(new InitializedEvent())
    })
    this.sendResponse(response)
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse
  ): void {
    this.sendResponse(response)
  }

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): void {
    const path = args.source.path

    // read file contents into array for direct access
    const lines = readFileSync(path).toString().split('\n')

    const breakpoints = new Array<Breakpoint>()

    const debuggerFilePath = this.convertClientPathToDebugger(path)

    this._debug_client.clearBreakPoints({ file: debuggerFilePath })
    // verify breakpoint locations
    for (const souceBreakpoint of args.breakpoints) {
      let l = this.convertClientLineToDebugger(souceBreakpoint.line)
      let verified = false
      while (l <= lines.length) {
        const line = lines[l - 1].trim()
        // if a line is empty or starts with '--' we don't allow to set a breakpoint but move the breakpoint down
        if (line.length == 0 || line.startsWith('--')) {
          l++
        } else {
          verified = true // this breakpoint has been validated
          break
        }
      }
      const bp = <DebugProtocol.Breakpoint>(
        new Breakpoint(verified, this.convertDebuggerLineToClient(l))
      )
      bp.id = this._breakPointID++
      breakpoints.push(bp)
      if (verified) {
        const sendbreakpoint = {
          line: l,
          file: debuggerFilePath,
          condition: undefined,
          hit_condition: undefined,
        }
        if (souceBreakpoint.condition) {
          sendbreakpoint.condition = souceBreakpoint.condition
        }
        if (souceBreakpoint.hitCondition) {
          sendbreakpoint.hit_condition = souceBreakpoint.hitCondition
        }
        this._debug_client.addBreakPoint(sendbreakpoint)
      }
    }
    this._breakPoints.set(path, breakpoints)

    // send back the actual breakpoint positions
    response.body = {
      breakpoints: breakpoints,
    }
    this.sendResponse(response)
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    // return the default thread
    response.body = {
      threads: [new Thread(LuaDebugSession.THREAD_ID, 'thread 1')],
    }
    this.sendResponse(response)
  }

  /**
   * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
   */
  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): void {
    this._debug_client.getStackTrace().then((res) => {
      if (res.result) {
        const startFrame =
          typeof args.startFrame === 'number' ? args.startFrame : 0
        const maxLevels =
          typeof args.levels === 'number'
            ? args.levels
            : res.result.length - startFrame
        const endFrame = Math.min(startFrame + maxLevels, res.result.length)
        const frames = new Array<StackFrame>()
        for (let i = startFrame; i < endFrame; i++) {
          const frame = res.result[i] // use a word of the line as the stackframe name
          const filename = this.convertDebuggerPathToClient(frame.file)
          const source = new Source(frame.id, filename)
          if (!frame.file.startsWith('@')) {
            source.sourceReference = this._sourceHandles.create(frame.file)
          }
          frames.push(
            new StackFrame(
              i,
              frame.func,
              source,
              this.convertDebuggerLineToClient(frame.line),
              0
            )
          )
        }
        response.body = {
          stackFrames: frames,
          totalFrames: res.result.length,
        }
      } else {
        response.success = false
        response.message = 'unknown error'
      }
      this.sendResponse(response)
    })
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    const scopes = [
      new Scope(
        'Local',
        this._variableHandles.create({
          type: 'get_local_variable',
          params: {
            stack_no: args.frameId,
          },
        }),
        false
      ),
      new Scope(
        'Upvalues',
        this._variableHandles.create({
          type: 'get_upvalues',
          params: {
            stack_no: args.frameId,
          },
        }),
        false
      ),
      new Scope(
        'Global',
        this._variableHandles.create({
          type: 'get_global',
          params: {},
        }),
        true
      ),
    ]

    response.body = {
      scopes: scopes,
    }
    this.sendResponse(response)
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): void {
    const parent = this._variableHandles.get(args.variablesReference)

    if (parent != null) {
      const res = (() => {
        switch (parent.type) {
          case 'get_global':
            return this._debug_client
              .getGlobal(parent.params)
              .then((res) => res.result)
          case 'get_local_variable':
            return this._debug_client
              .getLocalVariable(parent.params)
              .then((res) => res.result)
          case 'get_upvalues':
            return this._debug_client
              .getUpvalues(parent.params)
              .then((res) => res.result)
          case 'eval':
            return this._debug_client
              .eval(parent.params)
              .then((res) => res.result[0])
          default:
            return Promise.reject(Error('invalid'))
        }
      })()

      res
        .then((result) =>
          this.variablesRequestResponce(response, result, parent)
        )
        .catch((err) => {
          response.success = false
          response.message = err.message
          this.sendResponse(response)
        })
    } else {
      response.success = false
      this.sendResponse(response)
    }
  }

  private variablesRequestResponce(
    response: DebugProtocol.VariablesResponse,
    variablesData: unknown,
    parent: VariableReference
  ): void {
    const evalParam = (k: string | number): EvalParam => {
      switch (parent.type) {
        case 'eval': {
          const key = typeof k === 'string' ? `"${k}"` : `${k}`
          return {
            type: 'eval',
            params: {
              ...parent.params,
              chunk: `(${parent.params.chunk})[${key}]`,
            },
          }
        }
        default: {
          return {
            type: 'eval',
            params: {
              stack_no: 0,
              ...parent.params,
              chunk: `${k}`,
              upvalue: parent.type === 'get_upvalues',
              local: parent.type === 'get_local_variable',
              global: parent.type === 'get_global',
            },
          }
        }
      }
    }
    const variables: DebugProtocol.Variable[] = []
    if (variablesData instanceof Array) {
      variablesData.forEach((v,i) => {
        const typename = typeof v
        const k = i + 1
        const varRef = (typename == 'object') ? this._variableHandles.create(evalParam(k)) : undefined
        variables.push({
          name: `${k}`,
          type: typename,
          value: stringify(v),
          variablesReference: varRef,
        })
      })
    } else if (typeof variablesData === 'object') {
      for (const k in variablesData) {
        const typename = typeof variablesData[k]
        const varRef =  (typename == 'object') ? this._variableHandles.create(evalParam(k)) : undefined
        variables.push({
          name: k,
          type: typename,
          value: stringify(variablesData[k]),
          variablesReference: varRef,
        })
      }
    }
    response.body = {
      variables: variables,
    }
    this.sendResponse(response)
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
 //   args: DebugProtocol.ContinueArguments
  ): void {
    this._debug_client.continue()
    this.sendResponse(response)
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
 //   args: DebugProtocol.NextArguments
  ): void {
    this._debug_client.step()
    this.sendResponse(response)
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
  //  args: DebugProtocol.StepInArguments
  ): void {
    this._debug_client.stepIn()
    this.sendResponse(response)
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
   // args: DebugProtocol.StepOutArguments
  ): void {
    this._debug_client.stepOut()
    this.sendResponse(response)
  }
  protected pauseRequest(
    response: DebugProtocol.PauseResponse,
  //  args: DebugProtocol.PauseArguments
  ): void {
    this._debug_client.pause()
    this.sendResponse(response)
  }

  protected sourceRequest(
    response: DebugProtocol.SourceResponse,
    args: DebugProtocol.SourceArguments
  ): void {
    const id = this._sourceHandles.get(args.sourceReference)
    if (id) {
      response.body = {
        content: id,
      }
    }
    this.sendResponse(response)
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
  //  args: DebugProtocol.DisconnectArguments
  ): void {
    if (this._debug_server_process) {
      this._debug_server_process.kill()
      delete this._debug_server_process
    }
    if (this._debug_client) {
      this._debug_client.end()
      delete this._debug_client
    }
    this.sendResponse(response)
  }

  protected evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): void {
    if (!this._debug_client) {
      response.success = false
      this.sendResponse(response)
      return
    }
    //		if (args.context == "watch" || args.context == "hover" || args.context == "repl") {
    const chunk = args.expression
    const requestParam = { stack_no: args.frameId, chunk: chunk, depth: 0 }
    this._debug_client.eval(requestParam).then((res) => {
      if (res.result instanceof Array) {
        const ret = res.result.map(v => stringify(v)).join('	')
        let varRef = 0
        if (res.result.length == 1) {
          const refobj = res.result[0]
          const typename = typeof refobj
          if (refobj && typename == 'object') {
            varRef = this._variableHandles.create({
              type: 'eval',
              params: requestParam,
            })
          }
        }
        response.body = {
          result: ret,
          variablesReference: varRef,
        }
      } else {
        response.body = {
          result: '',
          variablesReference: 0,
        }
        response.success = false
      }
      this.sendResponse(response)
    })
  }

  private handleServerEvents(event: LRDBClient.DebuggerNotify) {
    if (event.method == 'paused') {
      if (event.params.reason === 'entry' && !this._stopOnEntry) {
        this._debug_client.continue()
      } else {
        this.sendEvent(
          new StoppedEvent(event.params.reason, LuaDebugSession.THREAD_ID)
        )
      }
    } else if (event.method == 'running') {
      this._variableHandles.reset()
      this.sendEvent(new ContinuedEvent(LuaDebugSession.THREAD_ID))
    } else if (event.method == 'exit') {
      // non
    }
  }
}
