# Terminal AI Shortcuts

Extension VS Code pour créer des boutons intelligents qui ouvrent un terminal intégré et exécutent des commandes prédéfinies avec l'aide de l'IA.

## Installation
- Ouvrez ce dossier dans VS Code: `terminal-shortcuts/`
- Installez les dépendances: `npm install`
- Compilez: `npm run compile`
- Lancez en mode Extension: `F5` (Exécuter et déboguer > Lancer une fenêtre d’extension)

## Fonctionnalités
- Boutons de raccourci visibles:
  - Vue Explorer: panneau "Terminal AI Shortcuts" avec icônes light/dark.
  - Barre d’état (optionnelle): un bouton par raccourci.
- Gestion des terminaux:
  - Création/réutilisation de terminal selon le raccourci.
  - Exécution immédiate de la commande.
  - Nom de terminal configurable.
- Personnalisation:
  - Via paramètres `terminalShortcuts.commands` (workspace ou utilisateur).
  - OU via fichier JSON: `.vscode/terminal-shortcuts.json` (prioritaire s’il existe).
  - Icônes personnalisées (mode clair/sombre) pour la vue Explorer.

## Configuration
Deux méthodes complémentaires (le fichier JSON a priorité si présent):

1) Paramètres VS Code (`settings.json`):
- `terminalShortcuts.commands`: tableau d’objets raccourci
- `terminalShortcuts.showInStatusBar`: booléen (afficher tous les boutons en barre d’état)
- `terminalShortcuts.statusBar.alignment`: `left` | `right`
- `terminalShortcuts.statusBar.priority`: nombre

Exemple:
```
{
  "terminalShortcuts.showInStatusBar": true,
  "terminalShortcuts.commands": [
    {
      "id": "build",
      "label": "Build",
      "command": "npm run build",
      "terminalName": "Build",
      "reuse": true,
      "focus": true,
      "statusBar": true,
      "codicon": "tools",
      "icon": {
        "light": "images/light/build.svg",
        "dark": "images/dark/build.svg"
      }
    },
    {
      "id": "test",
      "label": "Test",
      "command": "npm test",
      "terminalName": "Test",
      "reuse": true,
      "focus": true,
      "statusBar": true,
      "codicon": "beaker",
      "icon": {
        "light": "images/light/test.svg",
        "dark": "images/dark/test.svg"
      }
    }
  ]
}
```

2) Fichier `.vscode/terminal-shortcuts.json` (dans le dossier du projet):
```
{
  "commands": [
    {
      "id": "deploy",
      "label": "Deploy",
      "command": "./deploy.sh",
      "terminalName": "Deploy",
      "reuse": false,
      "focus": true,
      "statusBar": false,
      "codicon": "rocket",
      "icon": {
        "light": "images/light/deploy.svg",
        "dark": "images/dark/deploy.svg"
      }
    }
  ]
}
```

Champs d’un raccourci:
- `id`: identifiant unique
- `label`: libellé affiché
- `command`: commande shell (sera envoyée au terminal)
- `terminalName`: nom du terminal
- `cwd`: répertoire de travail
- `env`: variables d’environnement `{ "KEY": "VAL" }`
- `reuse`: réutiliser le terminal du même nom si présent (défaut: true)
- `focus`: mettre le terminal au premier plan (défaut: true)
- `statusBar`: afficher ce raccourci en barre d’état si le global est désactivé
- `codicon`: icône codicon pour la barre d’état (ex: `rocket`, `tools`, `beaker`)
- `statusBarText`: texte personnalisé en barre d’état; sinon `label`
- `icon.light` / `icon.dark`: icônes SVG/PNG pour la vue Explorer (light/dark)

Notes:
- Les icônes de barre d’état utilisent les codicons internes VS Code.
- Les icônes personnalisées sont utilisées dans la vue Explorer, et peuvent pointer vers:
  - des assets de l’extension (ex: `images/light/build.svg`),
  - des chemins relatifs au workspace (`./icons/my.svg`),
  - ou des chemins absolus.

## Utilisation
- Ouvrir la palette: `Terminal AI Shortcuts: Exécuter…` et choisir un raccourci
- Panneau Explorer: cliquer sur un bouton dans la vue "Terminal AI Shortcuts"
- Barre d'état: cliquer sur les boutons si activés
- Recharger la configuration: `Terminal AI Shortcuts: Recharger`
- Ouvrir/Créer la config JSON: `Terminal AI Shortcuts: Ouvrir la configuration`

## Exemples de configuration
- Exemple prêt à copier: `examples/terminal-shortcuts.json` (Node, Docker, etc.).
- Copiez le contenu dans votre projet sous `.vscode/terminal-shortcuts.json`.

## Packaging (.vsix)
1) Installer l’outil de packaging:
   - `npm i -D @vscode/vsce`
2) Compiler l’extension:
   - `npm run compile`
3) Générer le paquet:
   - `npm run package` (ou `npx @vscode/vsce package`)
4) Installer le `.vsix` dans VS Code:
   - VS Code > Extensions > menu ••• > "Installer à partir d’un VSIX…"

## Compatibilité
- VS Code ≥ 1.80.0
- TypeScript

## Évolutions possibles
- GUI pour gérer les commandes
- Exécution de séquences de commandes
- Historique des terminaux
- Paramètres utilisateur supplémentaires dans les Settings VS Code
