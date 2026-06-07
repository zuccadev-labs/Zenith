/// <reference lib="deno.worker" />

/**
 * @module @zenith/ai/sandbox
 * 
 * ZERO-TRUST AI SANDBOX
 * Este Worker se ejecuta con TODOS los permisos del Sistema Operativo revocados.
 * No puede leer archivos, variables de entorno, ni ejecutar procesos.
 * Su único puente con el mundo real es el hilo principal (Zenith Core) a través de postMessage.
 */

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, jobId } = e.data;

  try {
    if (type === "EXECUTE_AGENT_TASK") {
       const { prompt, config } = payload;
       
       // El sandbox ejecuta la lógica de llamada al LLM
       // Dado que revocamos permisos de red genéricos, Deno solo permitirá fetch a las URLs autorizadas al instanciar el Worker.
       const response = await callLLMProvider(prompt, config) as {
         text: string;
         wantsDatabaseWrite?: boolean;
         targetCollection?: string;
         targetData?: unknown;
       };

       // El LLM podría querer ejecutar un comando en infraestructura.
       // El Sandbox NO PUEDE. Debe pedirle permiso al Host.
       if (response.wantsDatabaseWrite) {
          self.postMessage({
              type: "HOST_DB_REQUEST",
              jobId,
              action: "insert",
              collection: response.targetCollection,
              data: response.targetData
          });
          // Esperaríamos respuesta...
       }

       self.postMessage({ type: "TASK_SUCCESS", jobId, result: response.text });
    }
  } catch (err: any) {
    self.postMessage({ type: "TASK_FAILED", jobId, error: err.message });
  }
};

async function callLLMProvider(prompt: string, config: any) {
   if (config.provider === "ollama") {
      const url = config.ollamaUrl || "http://localhost:11434";
      const res = await fetch(`${url}/api/generate`, {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
            model: config.model,
            prompt: prompt,
            stream: false
         })
      });
      const data = await res.json();
      return { text: data.response };
   } 
   
   if (config.provider === "openai" || config.provider === "custom") {
      const url = config.customOpenAIEndpoint || "https://api.openai.com/v1/chat/completions";
      const res = await fetch(url, {
         method: "POST",
         headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.apiKey}`
         },
         body: JSON.stringify({
            model: config.model,
            messages: [{ role: "user", content: prompt }]
         })
      });
      const data = await res.json();
      return { text: data.choices[0].message.content };
   }

   // Implementar anthropic, gemini, etc...
   throw new Error(`Provider ${config.provider} not implemented in Sandbox`);
}
