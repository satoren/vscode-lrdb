

import * as net from 'net';
import { fork, spawn, ChildProcess, ForkOptions, SpawnOptions } from 'child_process';

import * as path from 'path';

export interface DebugServerEvent {
	method: string;
	params: any;
	param?: any;//
	error?: any;
	id: any;
}


export interface LRDBClient {
	send(method: string, param?: any, callback?: (response: any) => void);
	end();
	on_event: (event: DebugServerEvent) => void;
	on_close: () => void;
	on_open: () => void;
	on_error: (e: any) => void;
	on_output: (output: string, category?: string, data?: any) => void;
}

class LRDBTCPClient implements LRDBClient{
	private _connection: net.Socket;

	private _callback_map = {};
	private _request_id = 0;
	private _end = false;

	private on_close_() {
		for (var key in this._callback_map) {
			this._callback_map[key]({ result: null, id: key });
			delete this._callback_map[key];
		}

		if (this.on_close) {
			this.on_close();
		}
	}
	private on_connect_() {
		this._connection.on('close', () => {
			this.on_close_();
		});
		if (this.on_open) {
			this.on_open();
		}
	}

	public attach(port: number, host: string) {
		this._connection = net.connect(port, host);
		this._connection.on('connect', () => {
			this.on_connect_();
		});

		var retryCount = 0;
		this._connection.on('error', (e: any) => {
			if (e.code == 'ECONNREFUSED' && retryCount < 5) {
				retryCount++;
				this._connection.setTimeout(1000, () => {
					if (!this._end) {
						this._connection.connect(port, host);
					}
				});
				return;
			}

			console.error(e.message);
			if (this.on_error) {
				this.on_error(e);
			}
		});

		var chunk = "";
		var ondata = (data) => {
			chunk += data.toString();
			var d_index = chunk.indexOf('\n');
			while (d_index > -1) {
				try {
					var string = chunk.substring(0, d_index);
					var json = JSON.parse(string);
					this.receive(json);
				}
				finally { }
				chunk = chunk.substring(d_index + 1);
				d_index = chunk.indexOf('\n');
			}
		}
		this._connection.on('data', ondata);
	}

	public send(method: string, param?: any, callback?: (response: any) => void) {
		let id = this._request_id++;
		//TODO need remove param
		var data = JSON.stringify({ "jsonrpc": "2.0", "method": method, "params": param, "param": param, "id": id }) + "\n";
		var ret = this._connection.write(data);

		if (callback) {
			if (ret) {
				this._callback_map[id] = callback
			}
			else {
				setTimeout(function () {
					callback({ result: null, id: id });
				}, 0);
			}
		}
	}
	public receive(event: DebugServerEvent) {
		if (this._callback_map[event.id]) {
			this._callback_map[event.id](event);
			delete this._callback_map[event.id];
		}
		else {
			if (this.on_event) {
				this.on_event(event);
			}
		}
	}
	public end() {
		this._end = true;
		this._connection.end();
	}

	on_event: (event: DebugServerEvent) => void;
	on_data: (data: string) => void;
	on_close: () => void;
	on_open: () => void;
	on_error: (e: any) => void;
	on_output: (output: string, category?: string, data?: any) => void;
}

export class LuaLaunchClient extends LRDBTCPClient {
	private _child: ChildProcess;

	public constructor(port: number,program: string,programArg: string[],option:SpawnOptions) {
        super();        
		this._child = spawn(program, programArg, option);
        this.attach(port,'localhost')
        
		this._child.stdout.on('data', (data: any) => {
			this.on_output(data.toString(), 'stdout');
		});
		this._child.stderr.on('data', (data: any) => {
			this.on_output(data.toString(), 'stderr');
		});
		this._child.on('error', (msg: string) => {
			this.on_output(msg, 'error');
		});
		this._child.on('close', (code: number, signal: string) => {
			this.on_output(`exit status: ${code}\n`);
			this.on_close();
		});
    }
}
export class LuaAttachClient extends LRDBTCPClient {

	public constructor(port: number, host: string) {
        super();
        this.attach(port,host)
    }
}

export class InternalLuaLaunchClient implements LRDBClient {
	private _callback_map = {};
    private _request_id = 0;    
	private _child: ChildProcess;

	public constructor(program: string,programArg: string[],option:ForkOptions) {
        let vm = path.resolve(path.join(__dirname, '../../prebuilt/lua_with_lrdb_server.js'));
        this._child = fork(vm,
            [program].concat(programArg),option);

		setTimeout(() => {
			if (this.on_open) {
				this.on_open();
			}
		}, 0);
		this._child.on("message", (msg) => {
			this.receive(msg);
        });
        
        
		this._child.stdout.on('data', (data: any) => {
			this.on_output(data.toString(), 'stdout');
		});
		this._child.stderr.on('data', (data: any) => {
			this.on_output(data.toString(), 'stderr');
		});
		this._child.on('error', (msg: string) => {
			this.on_output(msg, 'error');
		});
		this._child.on('close', (code: number, signal: string) => {
			this.on_output(`exit status: ${code}\n`);
			this.on_close();
		});
	}


	public send(method: string, param?: any, callback?: (response: any) => void) {
		let id = this._request_id++;

		var ret = this._child.send({ "jsonrpc": "2.0", "method": method, "params": param, "id": id });

		if (callback) {
			if (ret) {
				this._callback_map[id] = callback
			}
			else {
				setTimeout(function () {
					callback({ result: null, id: id });
				}, 0);
			}
		}
	}
	public receive(event: DebugServerEvent) {
		if (event.params == null) {
			event.params = event.param;
		}
		if (this._callback_map[event.id]) {
			this._callback_map[event.id](event);
			delete this._callback_map[event.id];
		}
		else {
			if (this.on_event) {
				this.on_event(event);
			}
		}
	}
	public end() {
		for (var key in this._callback_map) {
			this._callback_map[key]({ result: null, id: key });
			delete this._callback_map[key];
        }
        if (this._child) {
			this._child.kill();
			delete this._child;
		}
	}
	on_event: (event: DebugServerEvent) => void;
	on_data: (data: string) => void;
	on_close: () => void;
	on_open: () => void;
	on_error: (e: any) => void;
	on_output: (output: string, category?: string, data?: any) => void;
}

