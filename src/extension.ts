import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'util';

type EnvMap = { [key: string]: string };

interface ShortcutIconConfig {
  light?: string;
  dark?: string;
}

interface TerminalShortcutConfig {
  id: string;
  label: string;
  command: string;
  terminalName?: string;
  cwd?: string;
  env?: EnvMap;
  reuse?: boolean;
  focus?: boolean;
  statusBar?: boolean;
  codicon?: string; // used in status bar
  statusBarText?: string;
  icon?: ShortcutIconConfig; // used in Explorer view
}

interface FileConfig {
  commands?: TerminalShortcutConfig[];
}

class ShortcutTreeItem extends vscode.TreeItem {
  public readonly shortcut: TerminalShortcutConfig;
  constructor(shortcut: TerminalShortcutConfig, icon: { light?: vscode.Uri; dark?: vscode.Uri } | vscode.ThemeIcon | undefined) {
    super(shortcut.label, vscode.TreeItemCollapsibleState.None);
    this.shortcut = shortcut;
    this.tooltip = `${shortcut.label} — ${shortcut.command}`;
    this.description = shortcut.terminalName ?? '';
    if (icon) {
      this.iconPath = icon as any;
    }
    this.command = {
      command: 'terminalShortcuts.runShortcut',
      title: 'Run Terminal Shortcut',
      arguments: [shortcut.id]
    };
    this.contextValue = 'terminalShortcutItem';
  }
}

class ShortcutTreeProvider implements vscode.TreeDataProvider<ShortcutTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly getShortcuts: () => TerminalShortcutConfig[], private readonly toIcon: (s: TerminalShortcutConfig) => { light?: vscode.Uri; dark?: vscode.Uri } | vscode.ThemeIcon | undefined) {}

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ShortcutTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<ShortcutTreeItem[]> {
    const items = this.getShortcuts().map(s => new ShortcutTreeItem(s, this.toIcon(s)));
    return Promise.resolve(items);
  }
}

let statusBarItems = new Map<string, vscode.StatusBarItem>();
let shortcuts: TerminalShortcutConfig[] = [];
let treeProvider: ShortcutTreeProvider | undefined;
let fileWatchers: vscode.FileSystemWatcher[] = [];

export function activate(context: vscode.ExtensionContext) {
  const disposables: vscode.Disposable[] = [];

  const load = async () => {
    shortcuts = await loadShortcuts(context);
    rebuildStatusBar(context);
    treeProvider?.refresh();
  };

  treeProvider = new ShortcutTreeProvider(
    () => shortcuts,
    (s) => resolveTreeItemIcon(context, s)
  );
  vscode.window.registerTreeDataProvider('terminalShortcutsView', treeProvider);

  disposables.push(
    vscode.commands.registerCommand('terminalShortcuts.run', async () => {
      await ensureLoaded(load);
      if (!shortcuts.length) {
        vscode.window.showInformationMessage('Aucun raccourci défini. Ouvrir la configuration ?', 'Ouvrir').then(sel => {
          if (sel) vscode.commands.executeCommand('terminalShortcuts.openConfig');
        });
        return;
      }
      const pick = await vscode.window.showQuickPick(
        shortcuts.map(s => ({
          label: s.label,
          description: s.terminalName || '',
          detail: s.command,
          s
        })),
        { placeHolder: 'Choisissez un raccourci à exécuter' }
      );
      if (!pick) return;
      await runShortcut(pick.s);
    }),
    vscode.commands.registerCommand('terminalShortcuts.runShortcut', async (id?: string) => {
      await ensureLoaded(load);
      if (!id) return;
      const s = shortcuts.find(x => x.id === id);
      if (s) {
        await runShortcut(s);
      } else {
        vscode.window.showErrorMessage(`Raccourci introuvable: ${id}`);
      }
    }),
    vscode.commands.registerCommand('terminalShortcuts.refresh', async () => {
      await load();
      vscode.window.setStatusBarMessage('Terminal Shortcuts rechargé.', 1500);
    }),
    vscode.commands.registerCommand('terminalShortcuts.openConfig', async () => {
      await openOrCreateConfig();
    }),
  );

  // Watch settings
  disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('terminalShortcuts')) {
      load();
    }
  }));

  // Watch config files
  setupFileWatchers(load);

  // initial load
  load();

  context.subscriptions.push(...disposables);
}

export function deactivate() {
  disposeStatusBar();
  fileWatchers.forEach(w => w.dispose());
  statusBarItems.clear();
}

async function ensureLoaded(load: () => Thenable<void>) {
  if (!shortcuts || !Array.isArray(shortcuts)) {
    await load();
  }
}

async function loadShortcuts(context: vscode.ExtensionContext): Promise<TerminalShortcutConfig[]> {
  const fromFile = await readFileConfig();
  if (fromFile && fromFile.commands && Array.isArray(fromFile.commands)) {
    return normalizeShortcuts(context, fromFile.commands);
  }
  const config = vscode.workspace.getConfiguration('terminalShortcuts');
  const arr = config.get<TerminalShortcutConfig[]>('commands') || [];
  return normalizeShortcuts(context, arr);
}

function normalizeShortcuts(context: vscode.ExtensionContext, arr: TerminalShortcutConfig[]): TerminalShortcutConfig[] {
  // ensure defaults
  return arr.map(s => ({
    reuse: true,
    focus: true,
    codicon: 'terminal',
    ...s,
  }));
}

function resolveTreeItemIcon(context: vscode.ExtensionContext, s: TerminalShortcutConfig): { light?: vscode.Uri; dark?: vscode.Uri } | vscode.ThemeIcon | undefined {
  if (!s.icon || (!s.icon.light && !s.icon.dark)) {
    // fallback to codicon
    return new vscode.ThemeIcon(s.codicon || 'terminal');
  }
  const light = s.icon.light ? resolveIconUri(context, s.icon.light) : undefined;
  const dark = s.icon.dark ? resolveIconUri(context, s.icon.dark) : undefined;
  return { light, dark };
}

function resolveIconUri(context: vscode.ExtensionContext, p: string): vscode.Uri {
  // If path looks like extension asset (images/..), resolve from extension
  if (p.startsWith('images/')) {
    return vscode.Uri.joinPath(context.extensionUri, p);
  }
  // If relative and workspace exists, resolve from workspace
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (ws && (p.startsWith('./') || p.startsWith('../'))) {
    return vscode.Uri.joinPath(ws, p);
  }
  // Try absolute file path
  if (/^(\/[\s\S]*)|([A-Za-z]:\\[\s\S]*)/.test(p)) {
    return vscode.Uri.file(p);
  }
  // Fallback to extension path
  return vscode.Uri.joinPath(context.extensionUri, p);
}

async function readFileConfig(): Promise<FileConfig | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return undefined;
  const root = folders[0].uri;
  const primary = vscode.Uri.joinPath(root, '.vscode/terminal-shortcuts.json');
  const fallback = vscode.Uri.joinPath(root, 'terminal-shortcuts.json');
  for (const uri of [primary, fallback]) {
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(data);
      const config = JSON.parse(text);
      if (config && typeof config === 'object') return config as FileConfig;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function setupFileWatchers(onChange: () => void) {
  fileWatchers.forEach(w => w.dispose());
  fileWatchers = [];
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return;
  const patterns = ['**/.vscode/terminal-shortcuts.json', '**/terminal-shortcuts.json'];
  patterns.forEach(glob => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folders[0], glob));
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    fileWatchers.push(watcher);
  });
}

async function openOrCreateConfig() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    vscode.window.showWarningMessage("Pas de dossier ouvert. Utilisez les paramètres utilisateur 'terminalShortcuts.commands'.");
    await vscode.commands.executeCommand('workbench.action.openSettings', 'terminalShortcuts.commands');
    return;
  }
  const root = folders[0].uri;
  const dir = vscode.Uri.joinPath(root, '.vscode');
  const file = vscode.Uri.joinPath(dir, 'terminal-shortcuts.json');
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {}
  // If file doesn't exist, seed with example
  try {
    await vscode.workspace.fs.stat(file);
  } catch {
    const sample: FileConfig = {
      commands: [
        {
          id: 'build',
          label: 'Build',
          command: 'npm run build',
          terminalName: 'Build',
          reuse: true,
          focus: true,
          statusBar: true,
          codicon: 'tools',
          icon: {
            light: 'images/light/build.svg',
            dark: 'images/dark/build.svg'
          }
        },
        {
          id: 'test',
          label: 'Test',
          command: 'npm test',
          terminalName: 'Test',
          reuse: true,
          focus: true,
          statusBar: true,
          codicon: 'beaker',
          icon: {
            light: 'images/light/test.svg',
            dark: 'images/dark/test.svg'
          }
        }
      ]
    };
    const text = JSON.stringify(sample, null, 2);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
  }
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc, { preview: false });
}

function disposeStatusBar() {
  for (const item of statusBarItems.values()) {
    item.dispose();
  }
  statusBarItems.clear();
}

function rebuildStatusBar(context: vscode.ExtensionContext) {
  disposeStatusBar();
  const cfg = vscode.workspace.getConfiguration('terminalShortcuts');
  const showAll = cfg.get<boolean>('showInStatusBar') ?? false;
  const alignStr = cfg.get<string>('statusBar.alignment') ?? 'left';
  const priority = cfg.get<number>('statusBar.priority') ?? 100;
  const alignment = alignStr === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;

  for (const s of shortcuts) {
    if (!(showAll || s.statusBar)) continue;
    const item = vscode.window.createStatusBarItem(alignment, priority);
    const iconId = s.codicon || 'terminal';
    const label = s.statusBarText && s.statusBarText.trim().length > 0 ? s.statusBarText : `${s.label}`;
    item.text = `$(${iconId}) ${label}`.trim();
    item.tooltip = `${s.label} — ${s.command}`;
    item.command = { command: 'terminalShortcuts.runShortcut', title: s.label, arguments: [s.id] };
    item.show();
    statusBarItems.set(s.id, item);
  }
}

async function runShortcut(s: TerminalShortcutConfig) {
  const name = s.terminalName || s.label || s.id;
  let terminal: vscode.Terminal | undefined;
  if (s.reuse !== false) {
    terminal = vscode.window.terminals.find(t => t.name === name);
  }
  if (!terminal) {
    const options: vscode.TerminalOptions = {
      name,
      cwd: s.cwd,
      env: s.env,
      location: vscode.TerminalLocation.Editor
    };
    terminal = vscode.window.createTerminal(options);
  }
  const focus = s.focus !== false;
  terminal.show(focus);
  terminal.sendText(s.command, true);
}
