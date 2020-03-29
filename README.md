# Lua Remote DeBugger for Visual Studio Code

## Introduction

This extension is debug Lua programs with Visual Studio Code.

![Lua Debug](https://raw.githubusercontent.com/satoren/vscode-lrdb/master/images/lrdb.gif)

## Features

* Supports Windows,macOS,Linux
* Add/remove break points
* Conditional break points
* Continue,Pause,Step over, Step in, Step out
* Local,Global,_ENV,Upvalue variables and arguments
* Watch window
* Evaluate Expressions
* Debug with embedded Lua interpreter(Lua 5.3.3 on Javascript by Emscripten)
* Debug with Your host program([require embed debug server](https://github.com/satoren/LRDB))
* Remote debugging over TCP



## Extension Settings

launch.json example:
```
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "lrdb",
            "request": "launch",
            "name": "Lua Launch",
            "program": "${file}",
            "cwd": "${workspaceFolder}",
            "stopOnEntry": true
        },
        {
            "type": "lrdb",
            "request": "attach",
            "host": "192.168.1.28",
            "port": 21110,
            "name": "attach to remote debugger",
            "sourceRoot": "${workspaceFolder}",
            "sourceFileMap": {
                "${workspaceFolder}": "/mnt/luadb_b/"
            }
        }
    ]
}
```

## Release Notes
[CHANGELOG](CHANGELOG.md)