import { RESTController } from "../rest/RESTController.js";

export class ZenithCloud {
  /**
   * EN: Runs a Cloud Code function.
   * ES: Ejecuta una función de Cloud Code.
   */
  public static async run(
    functionName: string,
    params?: Record<string, any>,
    options?: { useMasterKey?: boolean, sessionToken?: string }
  ): Promise<any> {
    const res = await RESTController.request("POST", `/functions/${functionName}`, params, options);
    return res.result;
  }
}
