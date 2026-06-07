export interface ZenithConfig {
  appId: string;
  serverURL: string;
  javascriptKey?: string;
  masterKey?: string;
  clientKey?: string;
  restApiKey?: string;
}

export interface ZenithContext {
  sessionToken?: string;
  installationId?: string;
}
