import { describe, it, expect } from 'vitest'
import { createOfficialCatalog } from '../src/officialContent/catalog'

describe('official content 公共目录（S3，#787）', () => {
  it('expands official templates as user text and discloses skill bodies only on demand', () => {
    const catalog = createOfficialCatalog({ commands: [{ name: 'research', description: 'Research a topic', body: 'Investigate $ARGUMENTS with sources.' }], skills: [{ name: 'research', description: 'Use for research', body: 'Read primary sources first.' }] })
    expect(catalog.expand('/research batteries')).toBe('Investigate batteries with sources.')
    expect(catalog.expand('hello')).toBe('hello')
    expect(catalog.prompt).toContain('research: Use for research')
    expect(catalog.prompt).not.toContain('Read primary sources first.')
    expect(catalog.readSkill('research')).toBe('Read primary sources first.')
  })
})

it('enforces UTF-8 catalog/body limits and rejects duplicate or reserved command names', () => {
  const skill = { name: 'x', description: 'Research', body: 'body' }
  expect(() => createOfficialCatalog({ commands: [], skills: Array.from({ length: 51 }, (_, i) => ({ ...skill, name: `s${i}` })) })).toThrow('50')
  expect(() => createOfficialCatalog({ commands: [], skills: [{ ...skill, description: '中'.repeat(1400) }] })).toThrow('4KB')
  expect(() => createOfficialCatalog({ commands: [], skills: [{ ...skill, body: '中'.repeat(22000) }] })).toThrow('64KB')
  expect(() => createOfficialCatalog({ commands: [], skills: [skill, skill] })).toThrow('duplicate')
  expect(() => createOfficialCatalog({ commands: [{ ...skill, name: 'model' }], skills: [] })).toThrow('reserved')
  expect(() => createOfficialCatalog({ commands: [], skills: [{ ...skill, name: '../x' }] })).toThrow('name')
})
