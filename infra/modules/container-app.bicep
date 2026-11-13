// infra/modules/container-app.bicep
param prefix string
param location string
param acrName string
param acrResourceGroup string
param logAnalyticsWorkspaceId string
param appInsightsConnectionString string
param keyVaultName string
param imageTag string
param azureOpenAIEndpoint string
param azureRagDeployment string
param azureDeepRagDeployment string
param authMode string
param mcpAllowUrlKey bool
param timezone string

// Reference existing ACR
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
  scope: resourceGroup(acrResourceGroup)
}

// Container Apps Environment
resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: reference(logAnalyticsWorkspaceId, '2023-09-01').customerId
        sharedKey: listKeys(logAnalyticsWorkspaceId, '2023-09-01').primarySharedKey
      }
    }
  }
}

// Managed Identity for Key Vault + ACR access
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-identity'
  location: location
}

// Key Vault Secrets User role for the managed identity
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    principalId: identity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6') // Key Vault Secrets User
    principalType: 'ServicePrincipal'
  }
}

// NOTE: AcrPull for this identity on the shared ACR is granted outside the
// templates (see docs/deploy-azure.md, step 4):
// az role assignment create --assignee <identity-principal-id> --role AcrPull --scope <acr-resource-id>

// Container App (depends on KV role assignment)
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  dependsOn: [kvRoleAssignment]
  name: '${prefix}-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        { name: 'database-url', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/database-url', identity: identity.id }
        { name: 'devtrail-api-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/devtrail-api-key', identity: identity.id }
        { name: 'gemini-api-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/gemini-api-key', identity: identity.id }
        { name: 'anthropic-api-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/anthropic-api-key', identity: identity.id }
        { name: 'azure-openai-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/azure-openai-key', identity: identity.id }
        { name: 'xai-api-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/xai-api-key', identity: identity.id }
        { name: 'firecrawl-api-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/firecrawl-api-key', identity: identity.id }
        { name: 'supadata-api-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/supadata-api-key', identity: identity.id }
        { name: 'storage-connection-string', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/storage-connection-string', identity: identity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'devtrail'
          image: '${acr.properties.loginServer}/devtrail:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'DEVTRAIL_API_KEY', secretRef: 'devtrail-api-key' }
            { name: 'GEMINI_API_KEY', secretRef: 'gemini-api-key' }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'AZURE_OPENAI_KEY', secretRef: 'azure-openai-key' }
            { name: 'AZURE_OPENAI_ENDPOINT', value: azureOpenAIEndpoint }
            { name: 'AZURE_RAG_DEPLOYMENT', value: azureRagDeployment }
            { name: 'AZURE_DEEP_RAG_DEPLOYMENT', value: azureDeepRagDeployment }
            { name: 'XAI_API_KEY', secretRef: 'xai-api-key' }
            { name: 'FIRECRAWL_API_KEY', secretRef: 'firecrawl-api-key' }
            { name: 'SUPADATA_API_KEY', secretRef: 'supadata-api-key' }
            { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'storage-connection-string' }
            { name: 'AZURE_STORAGE_CONTAINER', value: 'devtrail-files' }
            { name: 'AUTH_MODE', value: authMode }
            { name: 'MCP_ALLOW_URL_KEY', value: string(mcpAllowUrlKey) }
            { name: 'TIMEZONE', value: timezone }
            { name: 'PORT', value: '3000' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              initialDelaySeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = containerApp.properties.configuration.ingress.fqdn
output identityPrincipalId string = identity.properties.principalId
