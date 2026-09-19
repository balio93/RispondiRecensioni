export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.GEMINI_API_KEY;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey) return json({ error: 'Chiave Gemini non configurata' }, 500);
  if (!serviceRoleKey) return json({ error: 'Chiave Supabase non configurata' }, 500);

  // Project URL Supabase (è pubblico, già visibile nel client)
  const SUPABASE_URL = "https://htixuodbcfdvvlsipedtl.supabase.co";

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Richiesta non valida' }, 400);
  }

  const { nome, settore, nomeRecensore, stelle, tono, recensione, lunghezza, firma, accessToken } = body;

  // === VERIFICA INPUT ===
  if (!accessToken) {
    return json({ error: 'Devi essere loggato per generare risposte' }, 401);
  }
  if (!nome || !recensione) {
    return json({ error: 'Nome attività e recensione sono obbligatori' }, 400);
  }

    // === VERIFICA UTENTE ===
  // Decodifichiamo il JWT per estrarre l'user ID (il token è firmato da Supabase)
  function decodeJWT(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64).split('').map(c =>
          '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
        ).join('')
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      return null;
    }
  }

  const payload = decodeJWT(accessToken);
  if (!payload || !payload.sub) {
    return json({ error: 'Token non valido. Effettua di nuovo il login.' }, 401);
  }
  if (payload.exp && (payload.exp * 1000) < Date.now()) {
    return json({ error: 'Sessione scaduta. Effettua di nuovo il login.' }, 401);
  }
  const userId = payload.sub;

  // === CONTROLLO LIMITE GIORNALIERO ===
  const oggi = new Date().toISOString().split('T')[0];
  const LIMITE_FREE = 3;

  let usoOggi = 0;
  try {
    const usageRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}&data=eq.${oggi}&select=risposte_usate`,
      {
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`
        }
      }
    );
    if (usageRes.ok) {
      const rows = await usageRes.json();
      if (rows.length > 0) usoOggi = rows[0].risposte_usate;
    }
  } catch (e) {
    // Se il controllo fallisce, meglio non bloccare l'utente
    console.error('Errore controllo usage', e);
  }

  if (usoOggi >= LIMITE_FREE) {
    return json({
      error: 'Hai esaurito le 3 risposte gratuite di oggi. Torna domani o passa a Pro.',
      limiteRaggiunto: true,
      rimanenti: 0
    }, 429);
  }

  // === COSTRUZIONE PROMPT ===
  const istruzioniRecensore = nomeRecensore
    ? `Il recensore si chiama "${nomeRecensore}". Usa il suo nome in modo naturale, senza cognome se non è indicato.`
    : `Non conosci il nome del recensore. NON usare formule generiche come "gentile ospite", "caro cliente", "gentile utente". Inizia direttamente con il contenuto.`;

  const istruzioniFirma = firma
    ? `Concludi con una firma semplice: "— Il team di ${nome}" oppure "— ${nome}" a seconda del contesto.`
    : `Non aggiungere alcuna firma finale.`;

  let strategiaStelle = '';
  if (stelle <= 2) {
    strategiaStelle = `Il cliente ha dato ${stelle} stella/e. Scrivi una risposta che:
- Riconosca il problema concreto senza minimizzarlo e senza scuse generiche.
- Mostri che l'attività prende sul serio l'accaduto.
- Offra un contatto diretto (email, telefono, oppure "scrivici in privato") per risolvere.
- NON chieda di cambiare la recensione.
- Ricorda che questa risposta sarà letta da ALTRI potenziali clienti: l'obiettivo è dimostrare trasparenza e serietà, non difendersi.
- Non essere servile né eccessivamente lungo: la sobrietà trasmette più credibilità.`;
  } else if (stelle === 3) {
    strategiaStelle = `Il cliente ha dato 3 stelle. Scrivi una risposta che:
- Ringrazi per l'onestà del feedback.
- Riconosca il gap tra l'esperienza avuta e quella che l'attività vuole offrire.
- Chieda (con garbo, senza essere insistente) cosa avrebbe potuto trasformare l'esperienza in 5 stelle.
- Inviti a tornare per una seconda possibilità.`;
  } else if (stelle === 4) {
    strategiaStelle = `Il cliente ha dato 4 stelle. Scrivi una risposta che:
- Ringrazi in modo caloroso ma non eccessivo.
- Citi un dettaglio specifico menzionato nella recensione.
- Chieda con delicatezza cosa mancava per il massimo dei voti, senza sembrare critico verso il cliente.
- Inviti a tornare.`;
  } else {
    strategiaStelle = `Il cliente ha dato 5 stelle. Scrivi una risposta che:
- Ringrazi con calore autentico, senza risultare sdolcinato.
- Citi almeno un dettaglio specifico menzionato nella recensione per dimostrare che è stata letta davvero.
- Inviti il cliente a tornare, magari accennando a qualcosa che potrebbe piacergli in futuro (senza inventare novità non menzionate).`;
  }

  const prompt = `Sei un esperto di customer care specializzato in ${settore}. Devi scrivere la risposta pubblica a una recensione ricevuta dall'attività "${nome}".

REGOLE OBBLIGATORIE:
1. Scrivi nella STESSA LINGUA della recensione (se è in inglese, rispondi in inglese; se in italiano, in italiano).
2. Tono: ${tono}.
3. Lunghezza: ${lunghezza}.
4. ${istruzioniRecensore}
5. VIETATO usare frasi fatte come: "ci dispiace per l'accaduto", "la vostra opinione è importante per noi", "grazie per il feedback", "gentile ospite", "caro cliente", "il suo feedback è prezioso". Sii specifico e umano.
6. Non inventare fatti, nomi, piatti, servizi o dettagli che non sono nella recensione.
7. Le stelle indicate (${stelle}) sono la guida principale, MA se il testo della recensione le contraddice (es. 5 stelle con critiche, o 1 stella con elogi), dai priorità al TESTO della recensione e adatta la risposta di conseguenza.
8. ${istruzioniFirma}

STRATEGIA IN BASE ALLE STELLE:
${strategiaStelle}

Recensione del cliente:
"""${recensione}"""

Rispondi SOLO con il testo della risposta, senza introduzioni, titoli, commenti o virgolette.`;

  // === GENERAZIONE ===
  const modelli = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];
  let testo = null;

  for (const modello of modelli) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modello}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        const msg = data.error?.message || '';
        if (msg.includes('high demand') || msg.includes('overloaded') || response.status === 503) {
          continue;
        }
        return json({ error: msg || 'Errore API' }, 500);
      }

      testo = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (testo) break;
    } catch (e) {
      continue;
    }
  }

  if (!testo) {
    return json({ error: 'Tutti i modelli sono momentaneamente occupati. Riprova tra 30 secondi.' }, 503);
  }

  // === INCREMENTO CONTATORE (solo dopo successo) ===
  const nuovoUso = usoOggi + 1;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/usage?on_conflict=user_id,data`, {
      method: 'POST',
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        user_id: userId,
        data: oggi,
        risposte_usate: nuovoUso
      })
    });
  } catch (e) {
    console.error('Errore salvataggio usage', e);
    // Non blocchiamo l'utente se il salvataggio fallisce
  }

  return json({
    testo,
    rimanenti: LIMITE_FREE - nuovoUso
  }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}
