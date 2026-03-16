// infra/modules/container-app.bicep
param prefix string
param location string
param acrName string
param acrResourceGroup string
param logAnalyticsWorkspaceId string
param appInsightsConnectionString string
param keyVaultName string

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

// NOTE: AcrPull role for the managed identity on the shared ACR (different RG)
// must be assigned via CLI after deployment:
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
        { name: 'open-brain-api-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/open-brain-api-key', identity: identity.id }
        { name: 'gemini-api-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/gemini-api-key', identity: identity.id }
        { name: 'anthropic-api-key', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/anthropic-api-key', identity: identity.id }
        { name: 'telegram-bot-token', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/telegram-bot-token', identity: identity.id }
        { name: 'telegram-webhook-secret', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/telegram-webhook-secret', identity: identity.id }
        { name: 'storage-connection-string', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/storage-connection-string', identity: identity.id }
        { name: 'telegram-chat-id', keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/telegram-chat-id', identity: identity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'open-brain'
          image: '${acr.properties.loginServer}/open-brain-v2:latest'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'OPEN_BRAIN_API_KEY', secretRef: 'open-brain-api-key' }
            { name: 'GEMINI_API_KEY', secretRef: 'gemini-api-key' }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'TELEGRAM_BOT_TOKEN', secretRef: 'telegram-bot-token' }
            { name: 'TELEGRAM_WEBHOOK_SECRET', secretRef: 'telegram-webhook-secret' }
            { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'storage-connection-string' }
            { name: 'AZURE_STORAGE_CONTAINER', value: 'open-brain-files' }
            { name: 'TELEGRAM_CHAT_ID', secretRef: 'telegram-chat-id' }
            { name: 'PORT', value: '3000' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'REVIEW_MODE', value: 'hybrid' }
            { name: 'DAILY_DIGEST_ENABLED', value: 'true' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/'
                port: 3000
              }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/'
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
