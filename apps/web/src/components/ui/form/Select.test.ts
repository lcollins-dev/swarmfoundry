import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import Select from './Select.vue';
import { SelectOptions } from './selectOptions';

const OPTIONS: SelectOptions<string> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first', disabled: true },
  { value: 'name', label: 'Name', description: 'A to Z' },
];

const mountSelect = (props: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) =>
  mount(Select<string>, {
    props: { options: OPTIONS, value: null, ...props },
    attrs,
    attachTo: document.body,
  });

type SelectWrapper = ReturnType<typeof mountSelect>;

const trigger = (wrapper: SelectWrapper) => wrapper.get('[role="combobox"]');

const activeLabel = (wrapper: SelectWrapper) => {
  const activeId = trigger(wrapper).attributes('aria-activedescendant');

  return activeId === undefined ? undefined : wrapper.get(`[id="${activeId}"]`).text();
};

const press = (wrapper: SelectWrapper, key: string) => trigger(wrapper).trigger('keydown', { key });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Select', () => {
  it('is a collapsed combobox showing its placeholder until a value is picked', async () => {
    const wrapper = mountSelect({ placeholder: 'Sort by' });

    expect(trigger(wrapper).attributes('aria-expanded')).toBe('false');
    expect(trigger(wrapper).attributes('aria-haspopup')).toBe('listbox');
    expect(trigger(wrapper).text()).toBe('Sort by');

    await wrapper.setProps({ value: 'name' });

    expect(trigger(wrapper).text()).toBe('Name');
  });

  it('opens a listbox of its options on click, marking the picked one', async () => {
    const wrapper = mountSelect({ value: 'name' });

    await trigger(wrapper).trigger('click');

    const listbox = wrapper.get('[role="listbox"]');
    const options = wrapper.findAll('[role="option"]');

    expect(trigger(wrapper).attributes('aria-expanded')).toBe('true');
    expect(trigger(wrapper).attributes('aria-controls')).toBe(listbox.attributes('id'));
    expect(options.map(option => option.attributes('aria-selected'))).toEqual(['false', 'false', 'true']);
    expect(options[1].attributes('aria-disabled')).toBe('true');
    expect(activeLabel(wrapper)).toContain('Name');
  });

  it('opens from the keyboard on the first enabled option and steps past disabled ones', async () => {
    const wrapper = mountSelect();

    await press(wrapper, 'ArrowDown');

    expect(trigger(wrapper).attributes('aria-expanded')).toBe('true');
    expect(activeLabel(wrapper)).toBe('Newest first');

    await press(wrapper, 'ArrowDown');

    expect(activeLabel(wrapper)).toContain('Name');

    await press(wrapper, 'ArrowDown');

    expect(activeLabel(wrapper)).toBe('Newest first');

    await press(wrapper, 'ArrowUp');

    expect(activeLabel(wrapper)).toContain('Name');
  });

  it('jumps to the first and last enabled options with Home and End', async () => {
    const wrapper = mountSelect();

    await press(wrapper, 'Enter');
    await press(wrapper, 'End');

    expect(activeLabel(wrapper)).toContain('Name');

    await press(wrapper, 'Home');

    expect(activeLabel(wrapper)).toBe('Newest first');
  });

  it.each(['Enter', ' '])('picks the active option with %j and closes', async key => {
    const wrapper = mountSelect();

    await press(wrapper, key);
    await press(wrapper, 'ArrowDown');
    await press(wrapper, key);

    expect(wrapper.emitted('update:value')).toEqual([['name']]);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
  });

  it('closes on Escape and Tab without picking', async () => {
    const wrapper = mountSelect();

    await press(wrapper, 'ArrowDown');
    await press(wrapper, 'Escape');

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);

    await press(wrapper, 'ArrowDown');
    await press(wrapper, 'Tab');

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(wrapper.emitted('update:value')).toBeUndefined();
  });

  it('picks an option on click and ignores a disabled one', async () => {
    const wrapper = mountSelect();

    await trigger(wrapper).trigger('click');
    await wrapper.findAll('[role="option"]')[1].trigger('click');

    expect(wrapper.emitted('update:value')).toBeUndefined();

    await wrapper.findAll('[role="option"]')[2].trigger('click');

    expect(wrapper.emitted('update:value')).toEqual([['name']]);
  });

  it('closes on a click outside', async () => {
    const wrapper = mountSelect();

    await trigger(wrapper).trigger('click');
    // onClickOutside skips a click that lands in the same task as the one before it.
    await new Promise(resolve => setTimeout(resolve, 0));
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new Event('click', { bubbles: true }));
    await nextTick();

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
  });

  it('lists grouped options under a labelled group', async () => {
    const wrapper = mountSelect({
      options: ['Any', { label: 'Roles', options: ['Admin', { value: 'user', label: 'User' }] }],
    });

    await trigger(wrapper).trigger('click');

    const group = wrapper.get('[role="group"]');

    expect(wrapper.get(`[id="${group.attributes('aria-labelledby')}"]`).text()).toBe('Roles');
    expect(group.findAll('[role="option"]').map(option => option.text())).toEqual(['Admin', 'User']);
  });

  it('posts its value through a hidden input when named', () => {
    const wrapper = mountSelect({ value: 'name', name: 'sort' });

    expect(wrapper.get('input[type="hidden"]').attributes()).toMatchObject({ name: 'sort', value: 'name' });
  });

  it('puts its attributes on the combobox and its class on the wrapper', () => {
    const wrapper = mountSelect({}, { id: 'sort-input', 'aria-invalid': true, class: 'max-w-xs' });

    expect(trigger(wrapper).attributes('id')).toBe('sort-input');
    expect(trigger(wrapper).attributes('aria-invalid')).toBe('true');
    expect(trigger(wrapper).classes()).not.toContain('max-w-xs');
    expect(wrapper.classes()).toContain('max-w-xs');
  });
});
