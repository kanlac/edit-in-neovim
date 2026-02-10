import { TFile, FileSystemAdapter, Notice } from "obsidian";
import { findNvim, attach } from "neovim";
import { EditInNeovimSettings } from "./Settings";
import * as child_process from "node:child_process";
import * as net from "node:net";
import { existsSync } from "node:fs";
import { isPortInUse, searchForBinary, searchDirs, configureProcessSpawnArgs, SpawnProcessOptions } from "./utils";

export default class Neovim {
  instance: ReturnType<typeof attach> | undefined;
  process: ReturnType<(typeof child_process)["spawn"]> | undefined;
  settings: EditInNeovimSettings;
  nvimBinary: ReturnType<typeof findNvim>["matches"][number] | undefined;
  termBinary: string | undefined;
  tmuxBinary: string | undefined;
  adapter: FileSystemAdapter;
  apiKey: string | undefined;
  private startedVia: "headless" | "terminal" | "tmux" | "unknown" = "unknown";

  constructor(settings: EditInNeovimSettings, adapter: FileSystemAdapter, apiKey: string | undefined) {
    this.adapter = adapter;
    this.settings = settings;
    this.apiKey = apiKey;
    this.termBinary = settings.terminal ? searchForBinary(settings.terminal) : undefined;
    this.tmuxBinary = searchForBinary("tmux");
    this.nvimBinary = undefined;

    if (settings.terminal && !this.termBinary) {
      console.warn(`Could not find binary for ${settings.terminal}, double check it's on your PATH`)
    }

    if (this.settings.pathToBinary) {
      this.nvimBinary = { path: this.settings.pathToBinary, nvimVersion: "manual_path" };
      console.log(`Neovim Information:
  - Term Path: ${this.termBinary || "NOT FOUND"}
  - Nvim Path: ${this.nvimBinary.path}
  - Version: ${this.nvimBinary.nvimVersion}
  - Error: ${this.nvimBinary.error?.message}
`);
      return;
    }

    const foundNvimBinaries = findNvim({ orderBy: "desc", paths: searchDirs });
    if (foundNvimBinaries.matches.length > 0) {
      this.nvimBinary = foundNvimBinaries.matches[0];
      console.log(`Neovim Information:
  - Term Path: ${this.termBinary || "NOT FOUND"}
  - Nvim Path: ${this.nvimBinary.path}
  - Version: ${this.nvimBinary.nvimVersion}
  - Error: ${this.nvimBinary.error?.message}
`);
      return;
    }

    this.nvimBinary = { path: "", nvimVersion: undefined, error: new Error("Neovim binary not found, and no manual path specified") };
    console.warn("Using fallback neovim configuration, plugin will likely not function");

    if (!this.termBinary || !this.nvimBinary.nvimVersion || this.nvimBinary.error) {
      new Notice("edit-in-neovim:\nPotential issues in plugin config, check logs for more details", 5000);
    }
  }

  getBuffers = async () => {
    if (!this.instance) return [];

    try {
      return await this.instance.buffers;
    } catch (error) {
      new Notice(`edit-in-neovim:\nUnable to get Neovim buffers due to: ${error.message}`, 5000);
      return [];
    }
  };

  async newInstance(adapter: FileSystemAdapter) {
    if (this.settings.hostMode === "nvim" && this.process) {
      new Notice("edit-in-neovim:\nInstance already running", 5000);
      return;
    }

    if (!this.nvimBinary || this.nvimBinary?.path === "") {
      new Notice("No path to valid nvim binary has been found, skipping command", 5000)
      return;
    }

    const extraEnvVars: Record<string, string> = {}
    if (this.apiKey) extraEnvVars["OBSIDIAN_REST_API_KEY"] = this.apiKey
    if (this.settings.appname !== "") extraEnvVars["NVIM_APPNAME"] = this.settings.appname

    if (this.settings.hostMode === "tmux") {
      await this.spawnWithTmux(adapter, extraEnvVars);
      return;
    }

    const useHeadless = !this.termBinary;
    if (useHeadless) await this.spawnHeadless(adapter, extraEnvVars);
    else await this.spawnWithTerminal(adapter, extraEnvVars);
  }

  private async attachToServer(): Promise<boolean> {
    const listenAddr = this.settings.listenOn;
    try {
      // TCP address "host:port"
      const colonIdx = listenAddr.lastIndexOf(':');
      if (colonIdx > 0 && !listenAddr.startsWith("/") && !listenAddr.includes("\\\\")) {
        const host = listenAddr.substring(0, colonIdx);
        const port = parseInt(listenAddr.substring(colonIdx + 1));
        if (Number.isNaN(port)) throw new Error(`Invalid listen port in: ${listenAddr}`);
        const socket = net.createConnection({ host, port });
        this.instance = attach({ reader: socket, writer: socket });
      } else {
        // Unix socket / named pipe path
        this.instance = attach({ socket: listenAddr });
      }

      await this.instance.eval("1");
      return true;
    } catch (error) {
      this.instance = undefined;
      console.error("Neovim RPC connection failed:", error);
      return false;
    }
  }

  private async waitForServerReady(timeoutMs = 5000): Promise<boolean> {
    const start = Date.now();
    // Poll attach until it succeeds or timeout.
    while (Date.now() - start < timeoutMs) {
      if (await this.attachToServer()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  private async spawnHeadless(adapter: FileSystemAdapter, extraEnvVars: Record<string, string>) {
    const spawnArgs = ['--headless', '--listen', this.settings.listenOn];

    console.debug(`Attempting to spawn headless Neovim:
      Executable: ${this.nvimBinary!.path}
      Arguments: ${JSON.stringify(spawnArgs)}`);

    try {
      this.startedVia = "headless";
      this.process = child_process.spawn(this.nvimBinary!.path, spawnArgs, {
        cwd: adapter.getBasePath(),
        env: { ...process.env, ...extraEnvVars },
        stdio: 'ignore',
      });

      if (!this.process || this.process.pid === undefined) {
        new Notice("Failed to create Neovim process", 5000);
        this.process = undefined;
        return;
      }

      console.debug(`Neovim headless process running, PID: ${this.process.pid}`);
      this.registerProcessEvents();

      if (await this.waitForServerReady(7000)) {
        console.debug("Neovim RPC connection test successful.");
        new Notice(`Neovim server started on ${this.settings.listenOn}`, 4000);
      } else {
        new Notice(`Failed to connect to Neovim server at ${this.settings.listenOn}`, 7000);
        this.close();
      }
    } catch (error) {
      console.error("Error caught during child_process.spawn call itself:", error);
      new Notice(`Error trying to spawn Neovim: ${(error as Error).message}`, 10000);
      this.process = undefined;
      this.instance = undefined;
    }
  }

  private async spawnWithTerminal(adapter: FileSystemAdapter, extraEnvVars: Record<string, string>) {
    const terminalName = this.termBinary!.split('\\').pop()?.toLowerCase() || '';
    const defaultSpawnOptions: SpawnProcessOptions = {
      spawnArgs: [],
      cwd: adapter.getBasePath(),
      env: { ...process.env, ...extraEnvVars },
      shell: false,
      detached: false,
    };

    const spawnOptions = configureProcessSpawnArgs(defaultSpawnOptions, terminalName, this.termBinary!, this.nvimBinary!.path, this.settings.listenOn);

    console.debug(`Attempting to spawn process:
      Platform: ${process.platform}
      Executable: ${this.termBinary}
      Arguments: ${JSON.stringify(spawnOptions.spawnArgs)}
      Options: ${JSON.stringify(spawnOptions)}`);

    try {
      this.startedVia = "terminal";
      this.process = child_process.spawn(this.termBinary!, spawnOptions.spawnArgs, spawnOptions);

      if (!this.process || this.process.pid === undefined) {
        new Notice("Failed to create Neovim process", 5000);
        this.process = undefined;
        return;
      }

      console.debug(`Neovim process running, PID: ${this.process.pid}`);
      this.registerProcessEvents();

      if (await this.waitForServerReady(7000)) {
        console.debug("Neovim RPC connection test successful.");
        new Notice("Neovim instance started and connected.", 3000);
      } else {
        new Notice(`Failed to connect to Neovim server at ${this.settings.listenOn}`, 7000);
        // Don't kill the terminal immediately; user may still see error output.
      }
    } catch (error) {
      console.error("Error caught during child_process.spawn call itself:", error);
      new Notice(`Error trying to spawn Neovim: ${(error as Error).message}`, 10000);
      this.process = undefined;
      this.instance = undefined;
    }
  }

  private registerProcessEvents() {
    this.process?.on("error", (err) => {
      new Notice("edit-in-neovim:\nNeovim ran into an error, see logs for details");
      console.error(`Neovim process ran into an error: ${JSON.stringify(err, null, 2)}`);
      this.process = undefined;
      this.instance = undefined;
    });

    this.process?.on("close", (code) => {
      console.info(`nvim closed with code: ${code}`);
      this.process = undefined;
      this.instance = undefined;
    });

    this.process?.on("disconnect", () => {
      console.info("nvim disconnected");
      this.process = undefined;
      this.instance = undefined;
    });

    this.process?.on("exit", (code) => {
      console.info(`nvim closed with code: ${code}`);
      this.process = undefined;
      this.instance = undefined;
    });
  }

  private async tmuxHasSession(sessionName: string): Promise<boolean> {
    if (!this.tmuxBinary) return false;
    try {
      child_process.execFileSync(this.tmuxBinary, ["has-session", "-t", sessionName], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private spawnTerminalToAttachTmux(sessionName: string) {
    if (!this.termBinary) {
      new Notice("edit-in-neovim:\nNo terminal configured; can't auto-attach to tmux.", 5000);
      return;
    }

    // Best-effort: most terminals on Unix support `-e <cmd...>`.
    // We keep it simple to avoid a large matrix of terminal flags.
    try {
      child_process.spawn(
        this.termBinary,
        ["-e", this.tmuxBinary ?? "tmux", "attach", "-t", sessionName],
        {
        cwd: this.adapter.getBasePath(),
        env: process.env,
        detached: true,
        stdio: "ignore",
        },
      );
    } catch (e) {
      console.error("Failed to spawn terminal to attach tmux:", e);
      new Notice("edit-in-neovim:\nFailed to open terminal to attach tmux (see logs).", 7000);
    }
  }

  private async spawnWithTmux(adapter: FileSystemAdapter, extraEnvVars: Record<string, string>) {
    if (process.platform === "win32") {
      new Notice("edit-in-neovim:\ntmux host mode is not supported on Windows by this plugin.", 7000);
      return;
    }

    if (!this.tmuxBinary) {
      new Notice("edit-in-neovim:\nCould not find tmux on PATH. Install tmux or switch host mode back to 'nvim'.", 10000);
      return;
    }

    this.startedVia = "tmux";
    const sessionName = (this.settings.tmuxSessionName || "edit-in-neovim").trim();

    const listenAddr = this.settings.listenOn;
    const colonIdx = listenAddr.lastIndexOf(":");
    const portStr = colonIdx > 0 ? listenAddr.substring(colonIdx + 1) : "";
    const isTcpListen = colonIdx > 0 && /^\d+$/.test(portStr) && !listenAddr.startsWith("/");
    const port = isTcpListen ? portStr : undefined;

    // If listenOn is TCP, make sure we won't accidentally "succeed" by connecting
    // to some existing Neovim server that isn't tmux-hosted.
    const sessionExists = await this.tmuxHasSession(sessionName);
    if (port && await isPortInUse(port)) {
      if (!sessionExists) {
        new Notice(
          `edit-in-neovim:\n${this.settings.listenOn} is already in use, so tmux-hosted Neovim can't bind to it.\n\nStop the existing Neovim server or choose a different listen address (a unix socket path is recommended).`,
          12000,
        );
        return;
      }
      // Session exists; we assume it's the intended host, so just (re)connect below.
    }

    if (!sessionExists) {
      const envPairs = Object.entries(extraEnvVars).flatMap(([k, v]) => [`${k}=${v}`]);
      const envBin = existsSync("/usr/bin/env") ? "/usr/bin/env" : "env";
      const args = [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        adapter.getBasePath(),
        envBin,
        ...envPairs,
        this.nvimBinary!.path,
        "--listen",
        this.settings.listenOn,
      ];

      console.debug(`Starting tmux-hosted Neovim:
        tmux: ${this.tmuxBinary}
        args: ${JSON.stringify(args)}`);

      try {
        child_process.execFileSync(this.tmuxBinary, args, { stdio: "ignore" });
      } catch (e) {
        console.error("Failed to start tmux session:", e);
        new Notice("edit-in-neovim:\nFailed to start tmux session (see logs).", 10000);
        return;
      }
    }

    if (this.settings.tmuxAttachOnStart) {
      this.spawnTerminalToAttachTmux(sessionName);
    }

    if (await this.waitForServerReady(7000)) {
      new Notice(`Neovim running in tmux session '${sessionName}'`, 4000);
    } else {
      // If the socket is supposed to be a filesystem path, mention it might not exist yet.
      if (!isTcpListen && !existsSync(this.settings.listenOn)) {
        new Notice(`edit-in-neovim:\nCouldn't connect to ${this.settings.listenOn}. If this is a socket path, it was not created.`, 10000);
      } else {
        new Notice(`edit-in-neovim:\nCouldn't connect to Neovim at ${this.settings.listenOn}. Is it running in tmux?`, 10000);
      }
    }
  }

  openFile = async (file: TFile | null) => {
    if (!file) return;
    if (!this.nvimBinary?.path) return;

    const isExcalidrawMd = file.extension === "md" && file.path.endsWith(".excalidraw.md");
    let isSupported = this.settings.supportedFileTypes.includes(file.extension);

    isSupported = isSupported || (isExcalidrawMd && this.settings.supportedFileTypes.includes("excalidraw"))

    if (!isSupported) return;

    const absolutePath = this.adapter.getFullPath(file.path);
    const args = ['--server', this.settings.listenOn, '--remote', absolutePath];

    console.debug(`Opening ${absolutePath} in neovim`);

    try {
      child_process.execFile(this.nvimBinary?.path, args, (error, stdout, stderr) => {
        if (error) {
          let noticeMessage = `edit-in-neovim:\nError opening file in Neovim: ${error.message}`;
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            noticeMessage = `edit-in-neovim:\nNeovim executable not found at: ${this.nvimBinary?.path}`;
          } else if (stderr && (stderr.includes('ECONNREFUSED') || stderr.includes('Connection refused'))) {
            noticeMessage = `edit-in-neovim:\nCould not connect to Neovim server at ${this.settings.listenOn}. Is it running?`;
          } else if (stderr && stderr.includes("No such file or directory") && stderr.includes(absolutePath)) {
            noticeMessage = `edit-in-neovim:\nNeovim server reported error finding file: ${file.basename}`;
          } else if (stderr) {
            noticeMessage = `edit-in-neovim:\nError opening file in Neovim: ${stderr.split('\n')[0]}`;
          }
          new Notice(noticeMessage, 10000);
          return;
        }

        if (stdout) console.log(`Neovim --remote stdout: ${stdout}`);
        if (stderr) console.warn(`Neovim --remote stderr: ${stderr}`);
      });
    } catch (execFileError) {
      console.error("Error opening file in neovim", execFileError);
      new Notice(`Failed to run Neovim command: ${execFileError.message}`, 10000);
    }

  };

  disconnect = () => {
    // Do not attempt to quit Neovim; just drop the RPC handle.
    this.instance = undefined;
    this.process = undefined;
  };

  onObsidianQuit = () => {
    if (this.startedVia === "tmux" && this.settings.tmuxKeepAliveOnQuit) {
      this.disconnect();
      return;
    }
    this.close();
  };

  close = () => {
    if (this.startedVia === "tmux") {
      const sessionName = (this.settings.tmuxSessionName || "edit-in-neovim").trim();
      if (!this.tmuxBinary) {
        this.disconnect();
        new Notice("edit-in-neovim:\nDisconnected from tmux-hosted Neovim (tmux not found).", 5000);
        return;
      }

      try {
        child_process.execFileSync(this.tmuxBinary, ["kill-session", "-t", sessionName], { stdio: "ignore" });
        this.disconnect();
        new Notice(`edit-in-neovim:\nKilled tmux session '${sessionName}'.`, 4000);
      } catch (e) {
        console.error("Failed to kill tmux session:", e);
        // Even if kill failed, disconnect local handles.
        this.disconnect();
        new Notice(`edit-in-neovim:\nFailed to kill tmux session '${sessionName}' (see logs).`, 10000);
      }
      return;
    }

    this.process?.kill();
    this.instance?.quit();

    this.instance = undefined;
    this.process = undefined;

    new Notice("edit-in-neovim:\nNeovim instance closed.", 3000);
  };
}
