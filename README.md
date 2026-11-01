# SmartScroll

Fil de vidéos verticales façon TikTok, limité aux sujets que tu choisis.
Les vidéos viennent de YouTube (recherche par l'API officielle, lecture par le
lecteur officiel). Web app installable (PWA) : iPhone, Android et ordinateur.

## Fonctions

- Sujets libres (« recettes rapides », « impression 3D »…), activables un par un,
  et puces en haut du fil pour n'en regarder qu'un.
- Filtre de pertinence : une vidéo n'entre dans le fil que si son titre, sa
  description ou ses tags contiennent au moins la moitié des mots du sujet
  (racines de 4 lettres, sans accents ni pluriel). Un sujet qui ne donne rien
  est signalé (faute de frappe probable).
- Mots à exclure (titre, description, tags), chaînes masquées.
- Filtres : Shorts verticaux ou toutes les vidéos, langue, ancienneté, tri.
- Favoris (cœur ou double tap), vidéos déjà vues jamais reproposées.
- Lien de configuration pour copier clé et réglages sur un autre appareil.

## Lancer en local

```sh
python3 -m http.server 8765
```

Puis ouvrir http://localhost:8765. Il faut passer par un serveur : ouvert en
`file://`, le lecteur YouTube refuse de lire les vidéos.

Pour tester sur le téléphone (même Wi-Fi) : `python3 -m http.server 8765 --bind 0.0.0.0`
puis ouvrir `http://<ip-du-mac>:8765` sur le téléphone.

## Clé API YouTube

1. https://console.cloud.google.com/projectcreate : créer un projet.
2. https://console.cloud.google.com/apis/library/youtube.googleapis.com : Activer.
3. https://console.cloud.google.com/apis/credentials : Créer des identifiants → Clé API.
4. Conseillé : restreindre la clé à « YouTube Data API v3 » et, une fois l'appli
   en ligne, à son adresse (restriction « Sites web » : `https://smartscroll.ivwi.fr/*`).

Quota gratuit : 10 000 unités par jour. Une recherche coûte 101 unités et
ramène jusqu'à 50 vidéos, soit ~99 recherches par jour. Remise à zéro à minuit
heure du Pacifique (9 h en France).

La clé n'est jamais dans le dépôt : elle est stockée dans le navigateur
(localStorage) de chaque appareil.

## Mise en ligne (GitHub Pages)

En ligne sur **https://smartscroll.ivwi.fr** (dépôt `DoubleV840/SmartScroll`).
Site statique sans build : un `git push` sur `main` suffit à publier.

- GitHub : Settings → Pages → « Deploy from a branch » → `main` / `(root)`.
  Le fichier `CNAME` donne le domaine ; `doublev840.github.io/SmartScroll`
  redirige vers lui.
- DNS (zone `ivwi.fr` chez OVH) : `smartscroll  CNAME  doublev840.github.io.`
- La clé API doit autoriser `https://smartscroll.ivwi.fr/*`.

Après une modification de `index.html`, `style.css` ou `app.js`, le service
worker sert la nouvelle version dès que le réseau répond (réseau d'abord).
Changer `CACHE` dans `sw.js` seulement si la liste des fichiers change.

## Fichiers

- `index.html` : structure (fil, barre de sujets, réglages, modèle de diapo).
- `app.js` : réserves de vidéos par sujet, appels API, lecteur, gestes, réglages.
- `style.css` : interface (thème sombre unique).
- `sw.js`, `manifest.webmanifest`, `icons/` : installation en appli.

## Limites connues

- TikTok n'offre pas de recherche publique : seul YouTube est utilisé.
- Sur iPhone, le premier son peut demander de toucher la vidéo elle-même
  (l'appli l'indique alors) ; ensuite le son reste actif.
