import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { VpcSecurityGroupEgressRule } from '@cdktf/provider-aws/lib/vpc-security-group-egress-rule';
import { VpcSecurityGroupIngressRule } from '@cdktf/provider-aws/lib/vpc-security-group-ingress-rule';

import { Construct } from 'constructs';

export type AllowedSecurityGroupInfo = { groupId: string; targetName: string };

export function securityGroupOnlyAllowAnotherSecurityGroup(
  scope: Construct,
  id: string,
  vpcId: string,
  allowedSecurityGroup: AllowedSecurityGroupInfo,
  port: number,
) {
  const securityGroup = new SecurityGroup(scope, `${id}-security-group`, {
    vpcId: vpcId,
    name: id,
    lifecycle: {
      createBeforeDestroy: true, // see https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#recreating-a-security-group
    },
  });

  new VpcSecurityGroupIngressRule(
    scope,
    `${id}-allow-${allowedSecurityGroup.targetName}`,
    {
      referencedSecurityGroupId: allowedSecurityGroup.groupId, // allowed source security group
      ipProtocol: 'tcp',
      securityGroupId: securityGroup.id,
      // port range, here we specify only a single port
      fromPort: port,
      toPort: port,
    },
  );

  allowAllEgressRule(scope, id, securityGroup.id);

  return securityGroup;
}

export function securityGroupAllowMultipleSecurityGroups(
  scope: Construct,
  id: string,
  vpcId: string,
  allowedSecurityGroups: AllowedSecurityGroupInfo[],
  port: number,
) {
  const securityGroup = new SecurityGroup(scope, `${id}-security-group`, {
    vpcId: vpcId,
    name: id,
    lifecycle: {
      createBeforeDestroy: true, // see https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#recreating-a-security-group
    },
  });

  for (const allowedSecurityGroup of allowedSecurityGroups) {
    new VpcSecurityGroupIngressRule(
      scope,
      `${id}-allow-${allowedSecurityGroup.targetName}`,
      {
        referencedSecurityGroupId: allowedSecurityGroup.groupId, // allowed source security group
        ipProtocol: 'tcp',
        securityGroupId: securityGroup.id,
        // port range, here we specify only a single port
        fromPort: port,
        toPort: port,
      },
    );
  }

  allowAllEgressRule(scope, id, securityGroup.id);

  return securityGroup;
}

export function allowAllEgressRule(
  scope: Construct,
  id: string,
  targetSecurityGroupId: string,
) {
  return new VpcSecurityGroupEgressRule(scope, `${id}-allow-all`, {
    cidrIpv4: '0.0.0.0/0',
    ipProtocol: '-1', // all
    securityGroupId: targetSecurityGroupId,
  });
}
