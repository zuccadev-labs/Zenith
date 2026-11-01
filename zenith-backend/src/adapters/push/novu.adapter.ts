/**
 * Push notification adapter interface — abstracts push delivery behind a common contract.
 */
export interface PushAdapter {
  /** Sends a push notification to one or more subscriber audiences */
  sendPush(payload: Record<string, any>, targetAudiences: string[]): Promise<void>;
}

/**
 * Creates a Novu push notification adapter implementing the PushAdapter interface.
 * Delegates push routing (FCM, APNs, etc.) to Novu's event-triggered workflow engine
 * instead of handling device tokens directly.
 *
 * @param apiKey - Novu API key for authentication
 * @param endpoint - Novu API endpoint (default: "http://localhost:3614/v1")
 * @returns PushAdapter — sendPush interface
 */
export function createNovuAdapter(apiKey: string, endpoint: string = "http://localhost:3614/v1"): PushAdapter {
  return {
    async sendPush(payload: Record<string, any>, targetAudiences: string[]) {
      // Usamos el endpoint de Eventos de Novu
      // Esto reemplaza FCM/APNs directo, delegando a Novu el enrutamiento.
      const url = `${endpoint}/events/trigger`;
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `ApiKey ${apiKey}`
        },
        body: JSON.stringify({
          name: payload.eventName || "zenith-push-event",
          to: targetAudiences.map(subscriberId => ({ subscriberId })),
          payload: payload.data
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Novu Push Failed: ${response.status} ${errorText}`);
      }
    }
  };
}
