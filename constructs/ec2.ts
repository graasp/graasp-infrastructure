import { Ec2InstanceState } from '@cdktf/provider-aws/lib/ec2-instance-state';
import { Instance } from '@cdktf/provider-aws/lib/instance';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { VpcSecurityGroupIngressRule } from '@cdktf/provider-aws/lib/vpc-security-group-ingress-rule';
import { Fn, Token } from 'cdktf';

import { Construct } from 'constructs';

import { Vpc } from '../.gen/modules/vpc';
import { allowAllEgressRule } from './security_group';

export type S3BucketObjectOwnership = 'ObjectWriter' | 'BucketOwnerEnforced';

export class Ec2 extends Construct {
  name: string;
  ec2: Instance;
  securityGroup: SecurityGroup;

  constructor(
    scope: Construct,
    name: string,
    vpc: Vpc,
    gatekeeperKeyName: string,
    ami: string,
    instanceType: string,
    associatePublicIpAddress = false,
    isActive: boolean = true,
  ) {
    super(scope, name);

    this.name = name;
    // todo: check this works + how to download a key pair from aws
    // const keyPair = new KeyPair(this, `${name}-key-pair`, {
    //   keyName: `${name}-key-pair`,
    //   publicKey: publicKey.value,
    // });

    this.securityGroup = new SecurityGroup(
      scope,
      `${this.name}-security-group`,
      {
        vpcId: vpc.vpcIdOutput,
        name,
        lifecycle: {
          createBeforeDestroy: true, // see https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#recreating-a-security-group
        },
      },
    );

    this.ec2 = new Instance(this, `${this.name}-ec2`, {
      ami,
      instanceType,
      keyName: gatekeeperKeyName,
      associatePublicIpAddress,
      lifecycle: {
        ignoreChanges: ['associate_public_ip_address'],
      },
      tags: {
        Name: this.name,
      },
      // choose a random subnet in the given vpc
      subnetId: Fn.element(Token.asList(vpc.publicSubnetsOutput), 0),
      vpcSecurityGroupIds: [this.securityGroup.id],
    });

    // define an instance state to manage power on and off
    new Ec2InstanceState(this, `${this.name}-state`, {
      instanceId: this.ec2.id,
      state: isActive ? 'running' : 'stopped',
    });

    // allow ssh from anywhere
    // Do not use the `ingress` and `egress` directly on the SecurityGroup for limitations reasons
    // See note on https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#protocol
    new VpcSecurityGroupIngressRule(this, `${this.name}-allow-inbound-ssh`, {
      cidrIpv4: '0.0.0.0/0',
      fromPort: 22,
      ipProtocol: 'tcp',
      securityGroupId: this.securityGroup.id,
      toPort: 22,
    });

    // allow all egress
    allowAllEgressRule(scope, this.name, this.securityGroup.id);
  }

  addSecurityGroupIngress(ingressGroup: {
    port: number;
    name: string;
    id: string;
  }) {
    new VpcSecurityGroupIngressRule(
      this,
      `${this.name}-allow-${ingressGroup.name}`,
      {
        referencedSecurityGroupId: ingressGroup.id,
        ipProtocol: 'tcp',
        securityGroupId: this.securityGroup.id,
        fromPort: ingressGroup.port,
        toPort: ingressGroup.port,
      },
    );
  }
}
