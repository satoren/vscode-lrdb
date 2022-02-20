//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as path from 'path'

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import { DebugClient } from 'vscode-debugadapter-testsupport'
//import { DebugProtocol } from 'vscode-debugprotocol'

function sequenceVariablesRequest(
  dc: DebugClient,
  varref: number,
  datapath: string[]
) {
  let req = dc.variablesRequest({ variablesReference: varref })
  const last = datapath.pop()
  for (const p of datapath) {
    req = req.then((response) => {
      for (const va of response.body.variables) {
        if (va.name == p && va.variablesReference != 0) {
          return dc.variablesRequest({
            variablesReference: va.variablesReference,
          })
        }
      }
      throw Error(
        'not found:' + p + ' in ' + JSON.stringify(response.body.variables)
      )
    })
  }
  return req.then((response) => {
    for (const va of response.body.variables) {
      if (va.name == last) {
        return va
      }
    }
    throw Error(
      'not found:' + last + ' in ' + JSON.stringify(response.body.variables)
    )
  })
}

// Defines a Mocha test describe to group tests of similar kind together
describe('Lua Debug Adapter', () => {
  const DEBUG_ADAPTER = './out/debugAdapter.js'
  const PROJECT_ROOT = path.join(__dirname, '../')
  const DATA_ROOT = path.join(PROJECT_ROOT, 'test/lua/')

  let dc: DebugClient

  beforeEach(() => {
    dc = new DebugClient('node', DEBUG_ADAPTER, 'lua')
    return dc.start()
  })

  afterEach(() => dc.stop())

  describe('basic', () => {
    test('unknown request should produce error', async () => {
      const response = dc.send('illegal_request')

      await expect(response).rejects.toThrow()
    })
  })

  describe('initialize', () => {
    test('should return supported features', async () => {
      const response = await dc.initializeRequest()
      expect(response.body.supportsConfigurationDoneRequest).toBe(true)
    })

    test("should produce error for invalid 'pathFormat'", async () => {
      const response = dc.initializeRequest({
        adapterID: 'lua',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'url',
      })
      await expect(response).rejects.toThrow()
    })
  })

  describe('launch', () => {
    test('should run program to the end', async () => {
      const PROGRAM = path.join(DATA_ROOT, 'loop_test.lua')

      const response = Promise.all([
        dc.launch({ program: PROGRAM }),
        dc.configurationSequence(),
        dc.waitForEvent('terminated'),
      ])

      await expect(response).resolves.toHaveLength(3)
    })

    test('should stop on entry', async () => {
      const PROGRAM = path.join(DATA_ROOT, 'loop_test.lua')
      const ENTRY_LINE = 1
      const response = Promise.all([
        dc.launch({ program: PROGRAM, stopOnEntry: true }),
        dc.configurationSequence(),
        dc.waitForEvent('stopped'),
        dc.assertStoppedLocation('entry', { line: ENTRY_LINE }),
      ])
      await expect(response).resolves.toHaveLength(4)
    })
  })

  describe('breakpoint', () => {
    test('should stop on breakpoint', async () => {
      const PROGRAM = path.join(DATA_ROOT, 'loop_test.lua')
      const BREAK_LINE = 5
      const response = dc.hitBreakpoint(
        { program: PROGRAM },
        { path: PROGRAM, line: BREAK_LINE }
      )
      await expect(response).resolves.toHaveLength(3)
    })
  })
  describe('evaluate', () => {
    beforeEach(async () => {
      const PROGRAM = path.join(DATA_ROOT, 'loop_test.lua')
      await Promise.all([
        dc.launch({ program: PROGRAM, stopOnEntry: true }),
        dc.configurationSequence(),
        dc.waitForEvent('stopped'),
      ])
    })
    test('check watch results 1', async () => {
      const response = dc
        .evaluateRequest({
          expression: '{{1}}',
          context: 'watch',
          frameId: 0,
        })
        .then((response) =>
          sequenceVariablesRequest(dc, response.body.variablesReference, [
            '1',
            '1',
          ])
        )
      await expect(response).resolves.toMatchObject({ name: '1', value: '1' })
    })

    test('watch array value [1][1]', async () => {
      const response = dc
        .evaluateRequest({
          expression: '{{1}}',
          context: 'watch',
          frameId: 0,
        })
        .then((response) =>
          sequenceVariablesRequest(dc, response.body.variablesReference, [
            '1',
            '1',
          ])
        )
      await expect(response).resolves.toMatchObject({ name: '1', value: '1' })
    })

    test('watch array value [1][1][3]', async () => {
      const response = dc
        .evaluateRequest({
          expression: '{{{5,4}}}',
          context: 'watch',
          frameId: 0,
        })
        .then((response) => {
          return sequenceVariablesRequest(
            dc,
            response.body.variablesReference,
            ['1', '1', '2']
          )
        })
      await expect(response).resolves.toMatchObject({ name: '2', value: '4' })
    })
    test('watch object value ["a"][2]', async () => {
      const response = dc
        .evaluateRequest({
          expression: '{a={4,2}}',
          context: 'watch',
          frameId: 0,
        })
        .then((response) => {
          return sequenceVariablesRequest(
            dc,
            response.body.variablesReference,
            ['a', '2']
          )
        })
      await expect(response).resolves.toMatchObject({ name: '2', value: '2' })
    })
  })

  describe('upvalues', () => {
    beforeEach(() => {
      const PROGRAM = path.join(DATA_ROOT, 'get_upvalue_test.lua')
      const BREAK_LINE = 6
      return dc.hitBreakpoint(
        { program: PROGRAM, stopOnEntry: false },
        { path: PROGRAM, line: BREAK_LINE }
      )
    })
    function getUpvalueScope(frameID: number) {
      return dc.scopesRequest({ frameId: frameID }).then((response) => {
        for (const scope of response.body.scopes) {
          if (scope.name == 'Upvalues') {
            return scope
          }
        }
        throw Error('upvalue not found')
      })
    }
    test('check upvalues', async () => {
      return dc
        .scopesRequest({ frameId: 0 })
        .then((res) =>
          res.body.scopes.find((scope) => scope.name === 'Upvalues')
        )
        .then((ref) => dc.variablesRequest(ref))
        .then((res) => expect(res.body.variables[0]).toMatchSnapshot())
    })
    test('check upvalue a', async () => {
      const response = getUpvalueScope(0).then((scope) => {
        return sequenceVariablesRequest(dc, scope.variablesReference, ['a'])
      })
      await expect(response).resolves.toMatchObject({ name: 'a', value: '1' })
    })
    test('check upvalue table ["t"][1][1]', async () => {
      //local t={{1,2,3,4},5,6}
      const response = getUpvalueScope(0).then((scope) => {
        return sequenceVariablesRequest(dc, scope.variablesReference, [
          't',
          '1',
          '1',
        ])
      })

      await expect(response).resolves.toMatchObject({ name: '1', value: '1' })
    })

    test('check upvalue table ["t"][1][3]', async () => {
      const response = getUpvalueScope(0).then((scope) => {
        return sequenceVariablesRequest(dc, scope.variablesReference, [
          't',
          '1',
          '3',
        ])
      })
      await expect(response).resolves.toMatchObject({ name: '3', value: '3' })
    })
    test('check upvalue table ["t"][2]', async () => {
      const response = getUpvalueScope(0).then((scope) => {
        return sequenceVariablesRequest(dc, scope.variablesReference, [
          't',
          '2',
        ])
      })
      await expect(response).resolves.toMatchObject({ name: '2', value: '5' })
    })
  })

  describe('global', () => {
    beforeEach(() => {
      const PROGRAM = path.join(DATA_ROOT, 'get_global_variable_test.lua')
      const BREAK_LINE = 7
      return dc.hitBreakpoint(
        { program: PROGRAM, stopOnEntry: false },
        { path: PROGRAM, line: BREAK_LINE }
      )
    })
    test('check global values',  () => {
      return dc
        .scopesRequest({ frameId: 0 })
        .then((res) => res.body.scopes.find((scope) => scope.name === 'Global'))
        .then((ref) => dc.variablesRequest(ref))
        .then(((value) =>
              expect(value.body.variables).toContainEqual({
              name: '_VERSION',
              type: 'string',
              value: '"Lua 5.3"',
              variablesReference: 0
            })
        ))
    })
  })

  describe('local', () => {
    beforeEach(() => {
      const PROGRAM = path.join(DATA_ROOT, 'get_local_variable_test.lua')
      const BREAK_LINE = 7
      return dc.hitBreakpoint(
        { program: PROGRAM, stopOnEntry: false },
        { path: PROGRAM, line: BREAK_LINE }
      )
    })
    function getLocalScope(frameID: number) {
      return dc.scopesRequest({ frameId: frameID }).then((response) => {
        for (const scope of response.body.scopes) {
          if (scope.name == 'Local') {
            return scope
          }
        }
        throw Error('local value not found')
      })
    }

    test('check local_values', async () => {
      return dc
        .scopesRequest({ frameId: 0 })
        .then((res) => res.body.scopes.find((scope) => scope.name === 'Local'))
        .then((ref) => dc.variablesRequest(ref))
        .then((res) => expect(res).toMatchSnapshot())
    })
    test('get local_value1', async () => {
      const response = await getLocalScope(0).then((scope) => {
        return sequenceVariablesRequest(dc, scope.variablesReference, [
          'local_value1',
        ])
      })

      expect(response.value).toBe('1')
    })
    test('get local_value2', async () => {
      const response = await getLocalScope(0).then((scope) => {
        return sequenceVariablesRequest(dc, scope.variablesReference, [
          'local_value2',
        ])
      })
      expect(response.value).toBe('"abc"')
    })
    test('get local_value3', async () => {
      const response = await getLocalScope(0).then((scope) => {
        return sequenceVariablesRequest(dc, scope.variablesReference, [
          'local_value3',
        ])
      })
      expect(response.value).toBe('1')
    })
    test('get local_value4', async () => {
      const response = await getLocalScope(0).then((scope) => {
        return sequenceVariablesRequest(dc, scope.variablesReference, [
          'local_value4',
          '1',
        ])
      })
      expect(response.value).toBe('4234.3')
    })
  })
})
