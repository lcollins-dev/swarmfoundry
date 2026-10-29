<template>
  <div class="mx-auto mt-16 max-w-sm">
    <ui-result :icon="IconSearchOff" title="Page not found">
      There's nothing here. Check the link, or head back home.

      <template #actions>
        <ui-link to="/" unstyled>
          <ui-button type="primary">Go Home</ui-button>
        </ui-link>
      </template>
    </ui-result>
  </div>
</template>

<script setup lang="ts">
import IconSearchOff from '~icons/material-symbols/search-off-rounded';

import { UiButton, UiLink, UiResult } from '@/components/ui';
</script>
