function formatWhen(startAt) {
  if (!startAt) return '';
  return new Date(startAt).toLocaleString('es-UY', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateOnly(startAt) {
  if (!startAt) return '';
  return new Date(startAt).toLocaleDateString('es-UY', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function formatTimeOnly(startAt) {
  if (!startAt) return '';
  return new Date(startAt).toLocaleTimeString('es-UY', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function athleteName(row) {
  const name = [row.athlete_first_name, row.athlete_last_name].filter(Boolean).join(' ').trim();
  return name || 'Un atleta';
}

module.exports = {
  formatWhen,
  formatDateOnly,
  formatTimeOnly,
  athleteName,

  classPosted: ({ title, when, isSeries, instanceCount }) => ({
    title: isSeries ? 'Serie de clases publicada' : 'Clase publicada con éxito',
    body: isSeries
      ? `«${title}» ya está activa con ${instanceCount} sesión${instanceCount === 1 ? '' : 'es'} programada${instanceCount === 1 ? '' : 's'}. La primera comienza el ${when}.`
      : `«${title}» ya está visible para reservas. Inicio programado: ${when}.`,
  }),

  classScheduledAthlete: ({ title, when }) => ({
    title: 'Clase confirmada en tu agenda',
    body: `Quedaste inscrito/a en «${title}». Te esperamos el ${when}. Podés ver los detalles en Mis reservas.`,
  }),

  classScheduledInstructor: ({ title, when, athleteName: name }) => ({
    title: 'Nueva reserva confirmada',
    body: `${name} reservó «${title}» para el ${when}. Revisá tu panel para más detalles.`,
  }),

  classEndedAthlete: ({ title, when }) => ({
    title: 'Clase finalizada',
    body: `«${title}» (${when}) ha concluido. ¡Gracias por entrenar con Fitnexia!`,
  }),

  classEndedInstructor: ({ title, when }) => ({
    title: 'Sesión finalizada',
    body: `Tu clase «${title}» del ${when} ha finalizado correctamente.`,
  }),

  classReminder24h: ({ title, when }) => ({
    title: 'Recordatorio: clase mañana',
    body: `Mañana tenés «${title}» a las ${formatTimeOnly(when) || when}. Revisá ubicación y materiales antes de salir.`,
  }),

  classReminder1h: ({ title, when }) => ({
    title: 'Tu clase comienza en 1 hora',
    body: `«${title}» arranca a las ${formatTimeOnly(when) || when}. Preparate para comenzar.`,
  }),

  classReminder10m: ({ title }) => ({
    title: 'Tu clase comienza en 10 minutos',
    body: `«${title}» está por comenzar. Dirigite al punto de encuentro y disfrutá la sesión.`,
  }),

  paymentConfirmed: ({ title, amount, currency }) => ({
    title: 'Pago registrado correctamente',
    body: `Recibimos ${amount} ${currency} por «${title}». Guardamos el comprobante en tu historial.`,
  }),

  reviewInvite: ({ title }) => ({
    title: '¿Cómo estuvo tu clase?',
    body: `Contanos tu experiencia en «${title}». Tu opinión ayuda a otros atletas y mejora la comunidad.`,
  }),

  classCancelled: ({ title, when }) => ({
    title: 'Clase cancelada',
    body: `«${title}» del ${when} fue cancelada. Si corresponde, procesaremos el reembolso automáticamente.`,
  }),

  classUpdated: ({ title, when }) => ({
    title: 'Cambios en tu clase',
    body: `«${title}» (${when}) fue actualizada. Revisá horario, ubicación o detalles en la ficha de la clase.`,
  }),

  verificationApproved: ({ displayName }) => ({
    title: 'Perfil verificado',
    body: `¡Felicitaciones, ${displayName}! Tu perfil ya cuenta con la insignia Fitnexia verificada.`,
  }),

  verificationRejected: ({ displayName, preview }) => ({
    title: 'Verificación pendiente de corrección',
    body: `${displayName}, tu solicitud no fue aprobada. Motivo: ${preview}. Podés volver a enviar los documentos.`,
  }),
};
