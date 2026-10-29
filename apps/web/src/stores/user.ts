import { useLocalStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type { ProfileResponseDto, UserRoleId } from '@libs/dto';

export const useUserStore = defineStore('user', () => {
  const canRegister = ref<boolean | null>(null);

  const token = useLocalStorage<string | null>('token', () => null);
  const profile = ref<ProfileResponseDto | null>(null);

  const loggedIn = computed(() => token.value !== null);

  const sessionEnded = ref(false);

  function setCanRegister(newCanRegister: boolean) {
    canRegister.value = newCanRegister;
  }

  function setToken(newToken: string | null) {
    sessionEnded.value = false;
    token.value = newToken;
  }

  function setProfile(newProfile: ProfileResponseDto | null) {
    profile.value = newProfile;
  }

  function clearAuth() {
    sessionEnded.value = false;
    token.value = null;
    profile.value = null;
  }

  /** Unlike `clearAuth`, the next sign in returns the user to the page they were on. */
  function endSession() {
    clearAuth();
    sessionEnded.value = true;
  }

  /** True where the profile holds any one of the roles, so an empty list never grants access. */
  function hasRole(...userRoleIds: UserRoleId[]) {
    return userRoleIds.some(userRoleId => profile.value?.userRoleIds.includes(userRoleId) === true);
  }

  return {
    canRegister,
    token,
    profile,
    loggedIn,
    sessionEnded,
    setCanRegister,
    setToken,
    setProfile,
    clearAuth,
    endSession,
    hasRole,
  };
});
