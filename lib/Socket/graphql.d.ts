/**
 * Execute a www-schema GraphQL query over HTTPS.
 * Transport (donor, APX.java): POST https://graph.whatsapp.com/graphql,
 * Content-Type application/json, body { access_token, doc_id, variables, lang }.
 */
export declare const executeWWWGraphQL: (docId: any, variables: any, accessToken: any, dataPath?: null, lang?: string, endpoint?: string) => Promise<any>;
/**
 * Execute a facebook-schema GraphQL query over HTTPS.
 * Transport (donor, WaFaConfigFetcher.java): POST https://acs.whatsapp.com/graphql.
 */
export declare const executeFacebookGraphQL: (docId: any, variables: any, accessToken: any, dataPath?: null, lang?: string) => Promise<any>;
/**
 * Execute a wamo-schema GraphQL query over HTTPS.
 * Transport (donor, WamoGraphQLExecutor.java): POST https://<wamoHost>/api/wamo/graphql/,
 * Content-Type application/x-www-form-urlencoded, body
 * access_token=<token>&credential=<cred>&user_id=<uid>&app_id=1015890928915437&doc_id=<id>&variables=<json>.
 */
export declare const executeWamoGraphQL: (docId: any, variables: any, wamoAuth?: {}, dataPath?: null, wamoHost?: string) => Promise<any>;
export declare const makeGraphQLSocket: (sock: any) => any;
//# sourceMappingURL=graphql.d.ts.map