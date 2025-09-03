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
  location?: 'editor' | 'panel';
  viewColumn?: number; // for editor location
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
  vscode.window.registerTreeDataProvider('terminalShortcutsViewExplorer', treeProvider);

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
    vscode.commands.registerCommand('terminalShortcuts.addGlobal', async () => {
      await ensureLoaded(load);
      const created = await promptAndCreateGlobalShortcut();
      if (created) {
        await load();
        vscode.window.showInformationMessage(`Raccourci global ajouté: ${created.label}`);
      }
    }),
    vscode.commands.registerCommand('terminalShortcuts.pinToGlobal', async (id?: string) => {
      await ensureLoaded(load);
      const s = id ? shortcuts.find(x => x.id === id) : undefined;
      if (!s) {
        vscode.window.showWarningMessage('Sélectionnez un raccourci dans la vue pour l’épingler.');
        return;
      }
      const updated = await upsertGlobalShortcut(s);
      if (updated) {
        await load();
        vscode.window.showInformationMessage(`Raccourci épinglé globalement: ${s.label}`);
      }
    }),
    vscode.commands.registerCommand('terminalShortcuts.openGui', async () => {
      await ensureLoaded(load);
      ShortcutGuiPanel.show(context, shortcuts);
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
  const config = vscode.workspace.getConfiguration('terminalShortcuts');
  const fromSettings = config.get<TerminalShortcutConfig[]>('commands') || [];
  const mergeWithSettings = config.get<boolean>('mergeUserAndWorkspace') ?? true;

  if (fromFile && fromFile.commands && Array.isArray(fromFile.commands)) {
    if (mergeWithSettings) {
      const merged = mergeShortcuts(fromFile.commands, fromSettings);
      return normalizeShortcuts(context, merged);
    }
    return normalizeShortcuts(context, fromFile.commands);
  }
  return normalizeShortcuts(context, fromSettings);
}

function normalizeShortcuts(context: vscode.ExtensionContext, arr: TerminalShortcutConfig[]): TerminalShortcutConfig[] {
  // ensure defaults
  return arr.map(s => ({
    reuse: true,
    focus: true,
    codicon: 'terminal',
    location: 'editor',
    ...s,
  }));
}

function mergeShortcuts(primary: TerminalShortcutConfig[], secondary: TerminalShortcutConfig[]): TerminalShortcutConfig[] {
  // Primary wins on id conflicts; append unique ids from secondary
  const ids = new Set(primary.map(s => s.id));
  const extras = secondary.filter(s => !ids.has(s.id));
  return [...primary, ...extras];
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
          location: 'editor',
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
          location: 'editor',
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
      location: resolveTerminalLocation(s)
    };
    terminal = vscode.window.createTerminal(options);
  }
  const focus = s.focus !== false;
  terminal.show(focus);
  terminal.sendText(s.command, true);
}

function resolveTerminalLocation(s: TerminalShortcutConfig): vscode.TerminalLocation | vscode.TerminalEditorLocationOptions {
  if (s.location === 'panel') return vscode.TerminalLocation.Panel;
  const col = toViewColumn(s.viewColumn);
  return { viewColumn: col, preserveFocus: s.focus === false };
}

function toViewColumn(n?: number): vscode.ViewColumn {
  switch (n) {
    case 2: return vscode.ViewColumn.Two;
    case 3: return vscode.ViewColumn.Three;
    default: return vscode.ViewColumn.Active;
  }
}

async function promptAndCreateGlobalShortcut(): Promise<TerminalShortcutConfig | undefined> {
  const label = await vscode.window.showInputBox({ prompt: 'Label du raccourci', value: 'My Shortcut', ignoreFocusOut: true });
  if (!label) return undefined;
  const command = await vscode.window.showInputBox({ prompt: 'Commande à exécuter', placeHolder: 'ex: claude --dangerously-skip-permissions', ignoreFocusOut: true });
  if (!command) return undefined;
  const defaultId = label.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_.]/g, '');
  const id = await vscode.window.showInputBox({ prompt: 'Identifiant (unique)', value: defaultId || 'shortcut', ignoreFocusOut: true });
  if (!id) return undefined;
  const terminalName = await vscode.window.showInputBox({ prompt: 'Nom du terminal (optionnel)', value: label, ignoreFocusOut: true });
  const showInStatus = await vscode.window.showQuickPick(['Oui', 'Non'], { placeHolder: 'Afficher en barre d’état ?', canPickMany: false, ignoreFocusOut: true });
  const where = await vscode.window.showQuickPick(['Éditeur (principal)', 'Panneau (bas)'], { placeHolder: 'Ouvrir le terminal où ?', canPickMany: false, ignoreFocusOut: true });
  const codicon = await vscode.window.showInputBox({ prompt: 'Icône codicon (optionnel, ex: robot, rocket, tools)', value: 'terminal', ignoreFocusOut: true });

  const newShortcut: TerminalShortcutConfig = {
    id,
    label,
    command,
    terminalName: terminalName || undefined,
    reuse: true,
    focus: true,
    statusBar: showInStatus === 'Oui',
    codicon: (codicon && codicon.trim()) ? codicon.trim() : 'terminal',
    location: where?.startsWith('Panneau') ? 'panel' : 'editor'
  };
  const ok = await upsertGlobalShortcut(newShortcut);
  return ok ? newShortcut : undefined;
}

async function upsertGlobalShortcut(s: TerminalShortcutConfig): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('terminalShortcuts');
  const current = cfg.get<TerminalShortcutConfig[]>('commands') || [];
  const idx = current.findIndex(x => x.id === s.id);
  if (idx >= 0) current[idx] = s; else current.push(s);
  try {
    await cfg.update('commands', current, vscode.ConfigurationTarget.Global);
    return true;
  } catch (e) {
    vscode.window.showErrorMessage('Impossible de mettre à jour les paramètres utilisateur pour enregistrer le raccourci.');
    return false;
  }
}

function makeUniqueId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 1;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// Simple GUI (webview) to add/edit one shortcut quickly
class ShortcutGuiPanel {
  public static current: ShortcutGuiPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext, shortcuts: TerminalShortcutConfig[]) {
    const column = vscode.ViewColumn.Active;
    if (ShortcutGuiPanel.current) {
      ShortcutGuiPanel.current.panel.reveal(column);
      ShortcutGuiPanel.current.update(shortcuts);
      return;
    }
    const panel = vscode.window.createWebviewPanel('terminalShortcutsGui', 'Terminal Shortcuts — GUI', column, {
      enableScripts: true,
    });
    ShortcutGuiPanel.current = new ShortcutGuiPanel(panel, context, shortcuts);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, shortcuts: TerminalShortcutConfig[]) {
    this.panel = panel;
    this.panel.onDidDispose(() => { ShortcutGuiPanel.current = undefined; });
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'saveGlobal' && msg.shortcut) {
        await upsertGlobalShortcut(msg.shortcut as TerminalShortcutConfig);
        vscode.window.showInformationMessage('Raccourci global enregistré.');
      } else if (msg?.type === 'saveWorkspace' && msg.shortcut) {
        await upsertWorkspaceShortcut(msg.shortcut as TerminalShortcutConfig);
        vscode.window.showInformationMessage('Raccourci enregistré dans le workspace.');
      } else if (msg?.type === 'requestTerminalName') {
        const names = vscode.window.terminals.map(t => t.name);
        if (!names.length) {
          vscode.window.showInformationMessage('Aucun terminal ouvert.');
        } else {
          const picked = await vscode.window.showQuickPick(names, { placeHolder: 'Choisissez un terminal existant' });
          if (picked) {
            this.panel.webview.postMessage({ type: 'setTerminalName', name: picked });
          }
        }
      } else if (msg?.type === 'duplicateGlobal' && msg.shortcut) {
        const s = msg.shortcut as TerminalShortcutConfig;
        const cfg = vscode.workspace.getConfiguration('terminalShortcuts');
        const current = cfg.get<TerminalShortcutConfig[]>('commands') || [];
        const exists = current.some(x => x.id === s.id);
        let toSave = { ...s };
        if (exists) {
          const choice = await vscode.window.showQuickPick([
            { label: 'Écraser', value: 'overwrite' },
            { label: 'Créer une copie (-global)', value: 'copy' }
          ], { placeHolder: `Un raccourci global avec l'id "${s.id}" existe déjà.` });
          if (!choice) return;
          if (choice.value === 'copy') {
            const ids = new Set(current.map(x => x.id));
            toSave.id = makeUniqueId(`${s.id}-global`, ids);
          }
        }
        await upsertGlobalShortcut(toSave);
        vscode.window.showInformationMessage(`Raccourci dupliqué en global: ${toSave.label} (${toSave.id})`);
      } else if (msg?.type === 'openWorkspaceJson') {
        await openOrCreateConfig();
      }
    });
    this.setHtml(shortcuts);
  }

  update(shortcuts: TerminalShortcutConfig[]) {
    this.setHtml(shortcuts);
  }

  private setHtml(shortcuts: TerminalShortcutConfig[]) {
    const escaped = (s: string) => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
    const list = shortcuts.map(s => `<option value="${escaped(s.id)}">${escaped(s.label)} — ${escaped(s.command)}</option>`).join('');
    this.panel.webview.html = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font: 13px/1.4 var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
    input, select { width: 100%; margin: 4px 0 10px; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
    label { font-weight: 600; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button { margin-right: 8px; }
    details { margin: 12px 0; }
    summary { cursor: pointer; font-weight: 600; }
  </style>
  <script>
    const vscode = acquireVsCodeApi();
    function getShortcut(){
      return {
        id: document.getElementById('id').value.trim(),
        label: document.getElementById('label').value.trim(),
        command: document.getElementById('command').value.trim(),
        terminalName: document.getElementById('tname').value.trim() || undefined,
        location: document.getElementById('location').value,
        reuse: document.getElementById('reuse').checked,
        focus: document.getElementById('focus').checked,
        statusBar: document.getElementById('statusBar').checked,
        codicon: document.getElementById('codicon').value.trim() || 'terminal'
      };
    }
    function loadFromList(){
      const sel = document.getElementById('existing');
      const id = sel.value;
      if(!id) return;
      const opt = sel.selectedOptions[0];
      const text = opt.textContent;
      document.getElementById('id').value = id;
      document.getElementById('label').value = text.split(' — ')[0];
      document.getElementById('command').value = (text.split(' — ')[1]||'');
    }
    function save(where){
      const s = getShortcut();
      if(!s.id || !s.label || !s.command){ alert('id, label, command requis'); return; }
      vscode.postMessage({ type: where === 'global' ? 'saveGlobal' : 'saveWorkspace', shortcut: s });
    }
    function requestTerminalName(){
      vscode.postMessage({ type: 'requestTerminalName' });
    }
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'setTerminalName' && msg.name) {
        const el = document.getElementById('tname');
        if (el) el.value = msg.name;
      }
    });
    function duplicateGlobal(){
      const s = getShortcut();
      if(!s.id || !s.label || !s.command){ alert('id, label, command requis'); return; }
      vscode.postMessage({ type: 'duplicateGlobal', shortcut: s });
    }
    function openWorkspaceJson(){
      vscode.postMessage({ type: 'openWorkspaceJson' });
    }
  </script>
</head>
<body>
  <h2>Configurer un raccourci</h2>
  <label>Charger depuis existant</label>
  <select id="existing" onchange="loadFromList()">
    <option value="">—</option>
    ${list}
  </select>
  <div class="row">
    <div>
      <label>Label</label>
      <input id="label" placeholder="Claude AI" />
    </div>
    <div>
      <label>Identifiant</label>
      <input id="id" placeholder="claude" />
    </div>
  </div>
  <label>Commande</label>
  <input id="command" placeholder="claude --dangerously-skip-permissions" />
  <div class="row">
    <div>
      <label>Nom du terminal</label>
      <div style="display:flex; gap:8px; align-items:center;">
        <input id="tname" placeholder="Claude" style="flex:1;" />
        <button type="button" onclick="requestTerminalName()">Choisir…</button>
      </div>
    </div>
    <div>
      <label>Emplacement</label>
      <select id="location">
        <option value="editor">Éditeur (principal)</option>
        <option value="panel">Panneau (bas)</option>
      </select>
    </div>
  </div>
  <div class="row">
    <div>
      <label><input type="checkbox" id="reuse" checked /> Réutiliser le terminal</label>
    </div>
    <div>
      <label><input type="checkbox" id="focus" checked /> Focus après exécution</label>
    </div>
  </div>
  <div class="row">
    <div>
      <label>Icône codicon</label>
      <input id="codicon" placeholder="robot" value="terminal" />
    </div>
    <div>
      <label><input type="checkbox" id="statusBar" /> Afficher en barre d’état</label>
    </div>
  </div>
  <p>
    <button onclick="save('global')">Enregistrer global</button>
    <button onclick="save('workspace')">Enregistrer dans le projet</button>
    <button onclick="duplicateGlobal()">Dupliquer en global</button>
    <button onclick="openWorkspaceJson()">Ouvrir JSON du projet</button>
  </p>
  <details>
    <summary>Aide</summary>
    <ul>
      <li>Label, Commande et Identifiant sont requis.</li>
      <li>Nom du terminal permet de réutiliser un terminal existant (bouton « Choisir… » pour sélectionner).</li>
      <li>Emplacement « Éditeur » ouvre le terminal dans la zone principale; « Panneau » l’ouvre en bas.</li>
      <li>« Enregistrer global » rend le raccourci disponible dans tous vos dossiers VS Code; « Enregistrer dans le projet » le stocke dans .vscode/terminal-shortcuts.json.</li>
      <li>« Dupliquer en global » copie ce qui est dans le formulaire vers vos paramètres globaux (avec gestion des conflits d’identifiant).</li>
    </ul>
  </details>
</body>
</html>`;
  }
}

async function upsertWorkspaceShortcut(s: TerminalShortcutConfig): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    vscode.window.showWarningMessage('Aucun dossier ouvert pour enregistrer dans le workspace.');
    return false;
  }
  const root = folders[0].uri;
  const dir = vscode.Uri.joinPath(root, '.vscode');
  const file = vscode.Uri.joinPath(dir, 'terminal-shortcuts.json');
  try { await vscode.workspace.fs.createDirectory(dir); } catch {}
  let json: FileConfig = { commands: [] };
  try {
    const data = await vscode.workspace.fs.readFile(file);
    json = JSON.parse(new TextDecoder('utf-8').decode(data));
    if (!json.commands) json.commands = [];
  } catch {}
  const idx = json.commands!.findIndex(x => x.id === s.id);
  if (idx >= 0) json.commands![idx] = s; else json.commands!.push(s);
  try {
    const text = JSON.stringify(json, null, 2);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
    return true;
  } catch (e) {
    vscode.window.showErrorMessage('Impossible d’écrire le fichier de configuration du workspace.');
    return false;
  }
}
