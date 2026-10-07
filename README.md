# Gestion PFMP

Interface responsive pour les enseignants et élèves, préparée pour GitHub Pages avec une base Supabase dédiée.

## État

L’interface est publiée sur https://arduino15650.github.io/gestion-pfmp/. Le backend Supabase dédié est installé, avec 3 042 entreprises et 45 élèves transférés depuis la sauvegarde privée du 7 octobre 2026. La fonction `pfmp-api` vérifie les sessions et les rôles, impose Authenticator aux enseignants et réserve l’inscription élève aux codes personnels. Le site d’origine est conservé.

Les essais réels ont vérifié le refus des accès anonymes, l’isolation des élèves, les codes à usage unique, Authenticator, les comptes rendus, la réservation exclusive et la libération d’une entreprise. La première activation du compte enseignant nécessite sa confirmation e-mail ; les URL de retour Supabase doivent pointer vers cette adresse GitHub Pages.

## Déploiement

1. Pour une nouvelle installation, utiliser un projet dédié. Vérifier l’identifiant et que la base est vide avant d’appliquer `supabase/schema.sql`. Ne pas rejouer ce fichier sur l’installation existante.
2. Déployer `supabase/functions/pfmp-api`. La fonction vérifie chaque session Supabase et réserve la création d’un compte élève à un code à usage unique. Sa clé de service reste exclusivement dans l’environnement serveur Supabase.
3. Initialiser les adresses enseignants autorisées dans `pfmp_teachers`, puis importer les entreprises, élèves, comptes rendus et réservations depuis une sauvegarde récente du site existant. Ne pas publier cette sauvegarde ni les fichiers Excel dans GitHub.
4. Configurer Supabase Auth : URL du site et redirections GitHub autorisées, confirmation des e-mails enseignants activée, TOTP activé, mots de passe de 12 caractères minimum, protection contre les mots de passe compromis si disponible. Ne pas désactiver la confirmation e-mail. Pour les élèves, la fonction valide l’invitation personnelle avant de créer leur compte.
5. Fournir uniquement `VITE_SUPABASE_URL` et la **clé publique** `VITE_SUPABASE_PUBLISHABLE_KEY` au build. Ne jamais utiliser une clé `service_role` ou `sb_secret` dans le navigateur.
6. Exécuter `npm ci`, `npm test`, `npm run build`, puis publier `dist` sur GitHub Pages. Le chemin de sous-dossier GitHub est pris en charge.

Le catalogue et les listes d’élèves sont masqués par défaut. Les données ne sont téléchargées qu’après connexion. Les rafraîchissements utilisent un numéro de révision pour éviter de retransmettre les 3 042 entreprises à chaque intervalle.

## Migration des comptes

Les mots de passe et les facteurs Authenticator de l’ancien système ne sont pas réutilisés. Les enseignants créent et confirment leur accès Supabase ; les élèves reçoivent un nouveau code généré par l’enseignant. Le site existant doit rester disponible jusqu’à la vérification du nouvel accès enseignant et du transfert des données récentes.

## Vérifications locales

`npm test` utilise PostgreSQL dans une base éphémère PGlite. Les tests portent sur les restrictions enseignants/élèves, la double authentification, le refus d’accès direct depuis le navigateur, les réservations exclusives, la suppression, les invitations et la révocation de session. Ils ne remplacent pas la vérification finale sur le projet Supabase réel.
