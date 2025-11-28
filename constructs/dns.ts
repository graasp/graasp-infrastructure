import {
  Route53Record,
  Route53RecordConfig,
} from '@cdktf/provider-aws/lib/route53-record';

import { Construct } from 'constructs';

export function createDNSEntry(
  scope: Construct,
  name: string,
  props: {
    zoneId: string;
    domainName: string;
    alias: { dnsName: string; zoneId: string };
  },
) {
  // domain config
  const recordConfig = {
    zoneId: props.zoneId,
    name: props.domainName,
    type: 'A',
    alias: {
      name: props.alias.dnsName,
      zoneId: props.alias.zoneId,
      evaluateTargetHealth: true,
    },
  } satisfies Route53RecordConfig;
  new Route53Record(scope, `${name}-A-record`, recordConfig);
  new Route53Record(scope, `${name}-AAAA-record`, {
    ...recordConfig,
    type: 'AAAA',
  });
}
