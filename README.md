# PulseHost

Hébergement bot Discord pro — sans connexion, upload de fichiers, console live.

## Lancer

```bash
npm install
npm start
```

- Landing : http://localhost:3000
- **Panel client** : http://localhost:3000/panel

## Utilisation

1. Ouvre `/panel` — ton espace client est créé automatiquement
2. **Nouveau projet** → un template `index.js` est généré
3. Upload ton bot (ZIP ou fichiers) dans l'onglet **Fichiers**
4. **Paramètres** → token Discord, fichier de démarrage (`index.js`, `main.py`...), variables d'env
5. **Démarrer** → suis les logs dans **Console**

## Fonctionnalités

- Upload ZIP / fichiers individuels
- Éditeur de code intégré
- Fichier de démarrage configurable
- Node.js & Python
- Variables d'environnement
- Console live (stdout/stderr)
- Start / Stop / Restart
- Auto-start au boot serveur
