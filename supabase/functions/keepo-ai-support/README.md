# 🤖 Assistant IA KEEPO — Guide de déploiement

Cette Edge Function alimente le chat IA dans `Aide & Support` du dashboard commerçant.
Elle utilise **Google Gemini 2.0 Flash** (gratuit jusqu'à 1500 requêtes/jour).

## 1️⃣ Obtenir une clé Gemini gratuite (2 min)

1. Allez sur https://aistudio.google.com/app/apikey
2. Connectez-vous avec un compte Google
3. Cliquez sur **"Create API key"** → "Create API key in new project"
4. Copiez la clé qui commence par `AIza...`

> Aucune carte bancaire demandée. Le free tier inclut 1500 requêtes/jour, 1M tokens/min — largement assez pour des centaines d'utilisateurs.

## 2️⃣ Installer la Supabase CLI

```bash
# Windows (avec scoop)
scoop install supabase

# Mac
brew install supabase/tap/supabase

# Ou via npm (multi-plateforme)
npm i -g supabase
```

## 3️⃣ Lier votre projet local au projet Supabase

```bash
cd G:/KEEPO

# Connexion (ouvre votre navigateur)
supabase login

# Liaison — récupérez le ref dans Supabase → Project Settings → Reference ID
supabase link --project-ref VOTRE_PROJECT_REF
```

## 4️⃣ Stocker la clé Gemini comme secret côté serveur

```bash
supabase secrets set GEMINI_API_KEY=AIzaSyXXXX...VOTRE_CLE
```

> ⚠️ Ne jamais commiter cette clé dans Git. Elle reste côté Supabase.

## 5️⃣ Déployer la fonction

```bash
supabase functions deploy KEEPO-ai-support --no-verify-jwt
```

Le flag `--no-verify-jwt` permet aux utilisateurs anonymes d'utiliser le chat (le frontend envoie déjà l'auth Bearer quand l'utilisateur est connecté, et la sécurité repose sur la clé Gemini cachée).

## ✅ Test rapide

Une fois déployé, ouvrez votre dashboard commerçant → `Aide & Support` → posez une question.
La réponse arrive en ~1-2 secondes.

## 🔄 Mise à jour de la fonction

Si vous modifiez `index.ts`, redéployez avec :
```bash
supabase functions deploy KEEPO-ai-support --no-verify-jwt
```

## 📊 Suivi de la consommation

Dans Google AI Studio → Usage : vous voyez les requêtes consommées en temps réel.
Au-delà de 1500 req/jour, les nouvelles requêtes retournent une erreur 429 (quota atteint).
Pour augmenter : activez le tier payant (~0.075$/M tokens — négligeable).

## 🛠️ Personnaliser le ton

Éditez le `SYSTEM_PROMPT` dans `index.ts` pour ajuster :
- La personnalité (formel/décontracté)
- Le périmètre d'aide (ajouter des fonctionnalités à connaître)
- La longueur des réponses
- Les redirections (vers ticket support, doc, etc.)

Puis redéployez.

## 🐛 Logs et debug

```bash
supabase functions logs KEEPO-ai-support --tail
```

Vous voyez en temps réel les requêtes entrantes et erreurs.
