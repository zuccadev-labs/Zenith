export interface PushAdapter {
  sendPush(payload: Record<string, any>, targetAudiences: string[]): Promise<void>;
}

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
