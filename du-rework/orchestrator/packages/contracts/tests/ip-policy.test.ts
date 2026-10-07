import {
  adjudicateUrlDestination,
  isDestinationAddressAllowed,
  isPrivateNetworkAddress,
} from '../src/ip-policy';

describe('shared IP destination policy', () => {
  test('private opt-in is limited to RFC1918, loopback, and IPv6 ULA', () => {
    const privateAddresses = [
      '10.0.0.1',
      '172.20.10.4',
      '192.168.1.8',
      '127.0.0.1',
      '::1',
      'fd12:3456::1',
      '::ffff:10.0.0.1',
      '2002:7f00:1::',
      '64:ff9b::a00:1',
    ];

    expect(privateAddresses.filter(isPrivateNetworkAddress)).toEqual(privateAddresses);
    for (const address of privateAddresses) {
      expect(isDestinationAddressAllowed(address)).toBe(false);
      expect(isDestinationAddressAllowed(address, { allowPrivateNetworks: true })).toBe(true);
    }
  });

  test('private opt-in does not allow unspecified, link-local, metadata, CGNAT, or multicast', () => {
    const alwaysDenied = [
      '0.0.0.0',
      '169.254.169.254',
      '100.64.1.1',
      '198.18.0.1',
      '192.0.0.1',
      '224.0.0.1',
      '::',
      'fe80::1',
      'ff02::1',
    ];

    for (const address of alwaysDenied) {
      expect(isPrivateNetworkAddress(address)).toBe(false);
      expect(isDestinationAddressAllowed(address, { allowPrivateNetworks: true })).toBe(false);
      expect(adjudicateUrlDestination(urlFor(address), { allowPrivateNetworks: true }).kind).toBe('DENIED');
    }
  });

  test('opt-in does not change public controls or bypass DNS resolution for names', () => {
    expect(adjudicateUrlDestination('http://192.0.2.1', { allowPrivateNetworks: true }).kind).toBe('ALLOWED');
    expect(adjudicateUrlDestination('https://provider.internal.test', {
      allowPrivateNetworks: true,
      allowHosts: new Set(['provider.internal.test']),
    }).kind).toBe('NEEDS_RESOLUTION');
  });

  test('protocol and userinfo validation remain mandatory with private opt-in', () => {
    expect(adjudicateUrlDestination('file:///etc/passwd', { allowPrivateNetworks: true }).kind).toBe('DENIED');
    expect(adjudicateUrlDestination('http://user:pass@127.0.0.1', {
      allowPrivateNetworks: true,
    }).kind).toBe('DENIED');
  });
});

function urlFor(address: string): string {
  return address.includes(':') ? `http://[${address}]:8080/` : `http://${address}:8080/`;
}
