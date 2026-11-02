<template>
  <ui-page-container>
    <ui-page-heading title="API keys" subtitle="Connect scripts and agents to Swarmfoundry." />

    <ui-card
      flush
      title="Your keys"
      subtitle="Read-only access to tasks, runs, transcripts, triggers and config using your account."
    >
      <template #header-extra>
        <ui-button type="primary" data-testid="create-api-key" @click="openCreate">
          <template #icon>
            <icon-add class="size-4" />
          </template>
          Create Key
        </ui-button>
      </template>

      <api-key-table
        :api-keys="apiKeys ?? []"
        :loading="loading"
        :revoking-id="revokingId"
        empty-text="No API keys yet. Create a key for a script or agent."
        @revoke="confirmRevoke"
      />
    </ui-card>

    <ui-card
      flush
      title="Connect an agent"
      subtitle="Give an agent read access to tasks, runs and transcripts over MCP."
    >
      <ui-steps>
        <ui-step title="Create a key">
          Create a key above for the agent and copy it. You can only see it once.
        </ui-step>

        <ui-step title="Add the server to your agent">
          <ui-segmented-control v-model:value="setup" class="mt-2" :options="SETUP_OPTIONS" />

          <div class="mt-3" :data-testid="`mcp-setup-${setup}`">
            <template v-if="setup === McpSetup.PROMPT">
              Paste this into your agent. It adds the server to its own client, then tells you where to put your key, so
              the key stays out of the conversation.

              <ui-copy-block class="mt-3" label="Prompt" :value="setupPrompt" value-test-id="mcp-setup-text" />
            </template>

            <template v-else-if="setup === McpSetup.CLAUDE_CODE">
              Put your key in place of <ui-code>{{ MCP_KEY_PLACEHOLDER }}</ui-code> and run this in a terminal. Claude
              Code saves it to your user config, so every session has it.

              <ui-copy-block class="mt-3" label="Command" :value="claudeCodeCommand" value-test-id="mcp-setup-text" />
            </template>

            <template v-else>
              Add the server to your client's MCP config over Streamable HTTP. Put your key in place of
              <ui-code>{{ MCP_KEY_PLACEHOLDER }}</ui-code> in the header.

              <ui-copy-values class="mt-3">
                <ui-copy-value label="URL" :value="serverUrl" value-test-id="mcp-server-url" />
                <ui-copy-value label="Header" :value="MCP_AUTH_HEADER" />
              </ui-copy-values>
            </template>
          </div>
        </ui-step>

        <ui-step title="Reconnect">
          Restart or reconnect your agent, so it loads the <ui-code>swarmfoundry</ui-code> tools. In Claude Code, run
          <ui-code>/mcp</ui-code> to check it's connected.
        </ui-step>
      </ui-steps>
    </ui-card>

    <ui-modal
      v-model:show="showCreate"
      class="max-w-md"
      :title="created ? 'Copy your key now' : 'Create API key'"
      :dismissible="created === null"
    >
      <template v-if="created" #icon>
        <ui-disc-icon :icon="IconPriorityHigh" :size="20" class="bg-warning text-surface" />
      </template>

      <template v-if="created">
        <p class="mb-4 mt-0">Copy this key and store it somewhere safe. You won't be able to view it again.</p>

        <div class="rounded-md border border-divider">
          <ui-copy-value :value="created.token" value-test-id="api-key-token" />
        </div>

        <p class="mb-0 mt-3 text-xs text-muted">
          Send it as <code>Authorization: Bearer &lt;key&gt;</code>. This key is read-only and does not expire.
        </p>

        <div class="mt-5 flex justify-end">
          <ui-button type="primary" @click="showCreate = false">Done</ui-button>
        </div>
      </template>

      <ui-form v-else :name="CREATE_FORM" @submit="doCreate">
        <ui-form-field
          v-slot="{ input }"
          label="Name"
          help="Choose a name that describes where you use this key."
          path="name"
        >
          <ui-input
            v-model:value="name"
            v-bind="input"
            name="api-key-name"
            autocomplete="off"
            placeholder="Laptop - Claude Code"
            :disabled="creating"
          />
        </ui-form-field>

        <div class="mt-5 flex justify-end gap-2">
          <ui-button :disabled="creating" @click="showCreate = false">Cancel</ui-button>

          <ui-button type="primary" native-type="submit" :loading="creating">Create Key</ui-button>
        </div>
      </ui-form>
    </ui-modal>
  </ui-page-container>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import IconAdd from '~icons/material-symbols/add-rounded';
import IconPriorityHigh from '~icons/material-symbols/priority-high-rounded';

import type { ApiKeyDto, CreateApiKeyResponseDto } from '@libs/dto';

import { DialogType } from '@/types/dialog';

import { useResource } from '@/composables/useResource';

import {
  MCP_AUTH_HEADER,
  MCP_KEY_PLACEHOLDER,
  mcpClaudeCodeCommand,
  McpSetup,
  mcpServerUrl,
  mcpSetupPrompt,
} from '@/utils/mcp';

import { useLogService } from '@/services/LogService';
import { useApiKeyAdminService } from '@/services/api/admin/ApiKeyAdminService';
import { useDialogStore } from '@/stores/dialog';
import { useNotificationStore } from '@/stores/notification';

import ApiKeyTable from '@/components/api-key/ApiKeyTable.vue';
import {
  UiButton,
  UiCard,
  UiCode,
  UiCopyBlock,
  UiCopyValue,
  UiCopyValues,
  UiDiscIcon,
  UiForm,
  UiFormField,
  UiInput,
  UiModal,
  UiPageContainer,
  UiPageHeading,
  UiSegmentedControl,
  UiStep,
  UiSteps,
  type ISegmentedControlOption,
} from '@/components/ui';

const CREATE_FORM = 'create-api-key';

const SETUP_OPTIONS: ISegmentedControlOption<McpSetup>[] = [
  { value: McpSetup.PROMPT, label: 'Agent prompt' },
  { value: McpSetup.CLAUDE_CODE, label: 'Claude Code' },
  { value: McpSetup.SERVER, label: 'Server details' },
];

const serverUrl = mcpServerUrl(window.location.origin);
const setupPrompt = mcpSetupPrompt(serverUrl);
const claudeCodeCommand = mcpClaudeCodeCommand(serverUrl);

const setup = ref(McpSetup.PROMPT);

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/ApiKeys');

const dialogStore = useDialogStore();
const notificationStore = useNotificationStore();
const apiKeyAdminService = useApiKeyAdminService();

const {
  data: apiKeys,
  loading,
  reload,
} = useResource({
  request: true,
  fetch: () => apiKeyAdminService.getApiKeyList(),
});

const showCreate = ref(false);
const name = ref('');
const creating = ref(false);
const created = ref<CreateApiKeyResponseDto | null>(null);

const revokingId = ref<number | null>(null);

const openCreate = () => {
  name.value = '';
  created.value = null;
  showCreate.value = true;
};

// Closing drops the key, which nothing else holds.
watch(showCreate, shown => {
  if (!shown) {
    created.value = null;
  }
});

const doCreate = () => {
  if (creating.value) {
    return;
  }

  creating.value = true;

  apiKeyAdminService
    .createApiKey({ name: name.value.trim() }, CREATE_FORM)
    .then(response => {
      created.value = response;
      notificationStore.addToast('API key created');

      return reload();
    })
    .finally(() => {
      creating.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doCreate(): Failed to create the API key');
    });
};

const confirmRevoke = (apiKey: ApiKeyDto) => {
  void dialogStore.confirm({
    type: DialogType.DANGER,
    title: `Revoke ${apiKey.name}?`,
    message: 'This permanently removes access for any script or agent using this key.',
    confirmLabel: 'Revoke Key',
    action: async () => {
      revokingId.value = apiKey.id;

      try {
        await apiKeyAdminService.revokeApiKey(apiKey.id);
        notificationStore.addToast('API key revoked');
        await reload();
      } finally {
        revokingId.value = null;
      }
    },
  });
};
</script>
