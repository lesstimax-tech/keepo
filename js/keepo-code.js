/* ════════════════════════════════════════════════════════════════
   KEEPO — Code court de passage

   Le QR du client encode « KEEPO:card:<client>:<commerce>:<minute> ».
   Quand la caméra n'arrive pas à le lire — écran sombre, film de
   protection, vitre fêlée, téléphone de commerçant qui a cinq ans — il
   faut un recours. Ce code en est un : le commerçant le saisit à la
   main, et le passage est crédité pareil.

   Il se DÉDUIT des mêmes données que le QR. Rien à stocker, rien à
   synchroniser entre les deux téléphones, et il expire tout seul avec
   la minute qui l'a produit.

   Sécurité : exactement celle du QR d'aujourd'hui. Les deux s'affichent
   sur l'écran du client, les deux changent chaque minute, ni l'un ni
   l'autre n'est un secret. Le code n'ouvre donc aucune porte nouvelle.
   ════════════════════════════════════════════════════════════════ */
window.KeepoCode = (function () {
  'use strict';

  /* Un alphabet sans les caractères qu'on confond en les lisant ou en
     les dictant : ni O ni 0, ni I ni 1, ni S ni 5, ni B ni 8.
     Vingt-huit signes, six positions — 481 millions de combinaisons. */
  var ALPHABET = 'ACDEFGHJKLMNPQRTUVWXYZ234679';
  var LONGUEUR = 6;

  /* La même granularité que le QR : une minute. */
  function minute() { return Math.floor(Date.now() / 60000); }

  /* Le code d'un client, chez un commerçant, à une minute donnée. */
  async function pour(clientId, merchantId, min) {
    var phrase = 'KEEPO:card:' + clientId + ':' + merchantId + ':' + min;
    var somme  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phrase));
    var octets = new Uint8Array(somme);
    var sortie = '';
    for (var i = 0; i < LONGUEUR; i++) sortie += ALPHABET[octets[i] % ALPHABET.length];
    return sortie;
  }

  /* On pardonne la casse, les espaces et les tirets — pas le reste :
     mieux vaut refuser un code douteux que créditer le mauvais client. */
  function normaliser(saisie) {
    return String(saisie || '').toUpperCase().replace(/[\s\-_.]/g, '');
  }

  function estValide(saisie) {
    var c = normaliser(saisie);
    if (c.length !== LONGUEUR) return false;
    for (var i = 0; i < c.length; i++) if (ALPHABET.indexOf(c[i]) === -1) return false;
    return true;
  }

  /* À qui appartient ce code ? On le recalcule pour chacun des clients du
     commerce. Cinquante à cent cinquante clients sur trois minutes, soit
     quelques centaines d'empreintes : imperceptible.

     La tolérance de trois minutes est celle du scan, qui accepte déjà un
     QR vieux de deux minutes — un commerçant qui recopie un code à la
     main n'est pas plus lent qu'une caméra qui s'entête. */
  async function retrouver(saisie, merchantId, clientIds) {
    if (!estValide(saisie) || !Array.isArray(clientIds) || !clientIds.length) return null;
    var cible = normaliser(saisie);
    var m = minute();
    for (var recul = 0; recul <= 2; recul++) {
      var min = m - recul;
      var codes = await Promise.all(clientIds.map(function (id) { return pour(id, merchantId, min); }));
      var i = codes.indexOf(cible);
      if (i !== -1) return clientIds[i];
    }
    return null;
  }

  /* Présentation : « AC3-K7P » se relit et se dicte mieux que « AC3K7P ». */
  function joli(code) {
    var c = normaliser(code);
    return c.length === LONGUEUR ? c.slice(0, 3) + ' ' + c.slice(3) : c;
  }

  return { minute: minute, pour: pour, retrouver: retrouver,
           normaliser: normaliser, estValide: estValide, joli: joli,
           LONGUEUR: LONGUEUR };
})();
