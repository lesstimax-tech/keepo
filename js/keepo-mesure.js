/* Mesure d'audience KEEPO — PostHog, hébergé en Europe, sans cookie.

   Rien n'est stocké dans le navigateur du visiteur : PostHog le reconnaît le
   temps d'une journée grâce à une empreinte calculée sur ses serveurs. Aucun
   bandeau cookies n'est donc nécessaire. Le script passe par keepo.eu/relais
   (voir _worker.js) et n'est chargé que sur les pages publiques : jamais sur
   les tableaux de bord, la caisse ou les pages de mot de passe.

   Pour que ses propres visites ne comptent pas : ouvrir une fois
   keepo.eu/?sans-stats sur chaque appareil (keepo.eu/?avec-stats pour annuler).

   Les pages envoient leurs événements par keepoMesure('nom', { … }) : la
   fonction existe toujours, même quand la mesure est coupée. */
(function () {
  var CLE_PROJET = 'phc_AG86yG7ZgXedX78yunKZjtXFLCZA7DrkBBV5z56d74xG';
  var SANS_STATS = 'keepo-sans-stats';

  window.keepoMesure = function () {};

  // En local ou en aperçu, on ne mesure rien.
  if (!/^(www\.)?keepo\.eu$/.test(location.hostname)) return;

  try {
    var p = new URLSearchParams(location.search);
    if (p.has('sans-stats')) localStorage.setItem(SANS_STATS, '1');
    if (p.has('avec-stats')) localStorage.removeItem(SANS_STATS);
    if (localStorage.getItem(SANS_STATS) === '1') return;
  } catch (e) { /* stockage bloqué : on mesure quand même */ }

  // Des adresses, on ne garde que la page, le code ambassadeur et l'origine
  // d'une campagne. Tout le reste part : un jeton de connexion glissé dans
  // l'adresse par un lien de confirmation, une recherche Google…
  var PARAMETRES_GARDES = /^(amb|ref|utm_(source|medium|campaign|content|term))$/;
  function nettoyerAdresse(adresse) {
    try {
      var u = new URL(adresse);
      var gardes = new URLSearchParams();
      u.searchParams.forEach(function (valeur, nom) {
        if (PARAMETRES_GARDES.test(nom)) gardes.append(nom, valeur);
      });
      u.search = gardes.toString();
      u.hash = '';
      return u.toString();
    } catch (e) { return adresse; }
  }
  function nettoyerProprietes(proprietes) {
    if (!proprietes) return;
    Object.keys(proprietes).forEach(function (nom) {
      var valeur = proprietes[nom];
      if (/url|referrer/i.test(nom) && typeof valeur === 'string' && /^https?:\/\//.test(valeur)) {
        proprietes[nom] = nettoyerAdresse(valeur);
      }
    });
  }

  // Le même départ que l'extrait officiel de PostHog : une file d'attente
  // que le vrai script reprend dès qu'il est chargé.
  var posthog = window.posthog = [];
  posthog.__SV = 1;
  posthog.people = [];
  posthog._i = [[CLE_PROJET, {
    api_host: location.origin + '/relais',
    ui_host: 'https://eu.posthog.com',
    cookieless_mode: 'always',
    person_profiles: 'never',
    capture_pageview: true,
    capture_pageleave: true,
    disable_session_recording: true,
    disable_surveys: true,
    // Pas de « drapeaux » ni d'expériences : on ne s'en sert pas, et leur
    // demande recopie l'adresse d'arrivée sans passer par before_send.
    advanced_disable_flags: true,
    disable_web_experiments: true,
    disable_product_tours: true,
    disable_conversations: true,
    before_send: function (evenement) {
      if (evenement) {
        nettoyerProprietes(evenement.properties);
        nettoyerProprietes(evenement.$set);
        nettoyerProprietes(evenement.$set_once);
      }
      return evenement;
    }
  }]];
  posthog.capture = function () {
    posthog.push(['capture'].concat(Array.prototype.slice.call(arguments)));
  };

  // send_instantly : une inscription est souvent suivie d'un changement de
  // page, l'événement ne doit pas attendre le prochain envoi groupé.
  window.keepoMesure = function (nom, proprietes) {
    try { window.posthog.capture(nom, proprietes || {}, { send_instantly: true }); } catch (e) {}
  };

  var script = document.createElement('script');
  script.async = true;
  script.src = '/relais/static/array.js';
  document.head.appendChild(script);
})();
