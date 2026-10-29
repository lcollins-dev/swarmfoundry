import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import Button from './Button.vue';

describe('Button', () => {
  it('is a plain button unless asked to submit', () => {
    expect(mount(Button).get('button').attributes('type')).toBe('button');
    expect(
      mount(Button, { props: { nativeType: 'submit' } })
        .get('button')
        .attributes('type')
    ).toBe('submit');
  });

  it('emits click', async () => {
    const wrapper = mount(Button);

    await wrapper.get('button').trigger('click');

    expect(wrapper.emitted('click')).toHaveLength(1);
  });

  it('ignores clicks and reports aria-busy while loading', async () => {
    const wrapper = mount(Button, { props: { loading: true } });

    await wrapper.get('button').trigger('click');

    expect(wrapper.emitted('click')).toBeUndefined();
    expect(wrapper.get('button').attributes('aria-busy')).toBe('true');
    expect(wrapper.find('svg').exists()).toBe(true);
  });

  it('shows the icon slot in place of the spinner when idle', () => {
    const wrapper = mount(Button, { slots: { icon: '<i class="icon" />', default: 'Invite User' } });

    expect(wrapper.find('.icon').exists()).toBe(true);
    expect(wrapper.find('svg').exists()).toBe(false);
    expect(wrapper.text()).toBe('Invite User');
  });

  it('disables the native button', () => {
    expect(
      mount(Button, { props: { disabled: true } })
        .get('button')
        .attributes('disabled')
    ).toBeDefined();
  });

  it('puts the field ids on the native button', () => {
    const wrapper = mount(Button, {
      props: {},
      attrs: { id: 'field-input', 'aria-describedby': 'field-help', 'aria-invalid': true },
    });
    const control = wrapper.get('button');

    expect(control.attributes('id')).toBe('field-input');
    expect(control.attributes('aria-describedby')).toBe('field-help');
    expect(control.attributes('aria-invalid')).toBe('true');
  });
});
