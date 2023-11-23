import { Construct } from 'constructs';
import { Instance } from '@cdktf/provider-aws/lib/instance';
import { Vpc } from '../.gen/modules/vpc';
import { allowAllEgressRule } from './security_group';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { VpcSecurityGroupIngressRule } from '@cdktf/provider-aws/lib/vpc-security-group-ingress-rule';
import { Fn, TerraformVariable, Token } from 'cdktf';

export type S3BucketObjectOwnership = 'ObjectWriter' | 'BucketOwnerEnforced';

export class Ec2 extends Construct {
  ec2: Instance;
  securityGroup: SecurityGroup;

  constructor(
    scope: Construct,
    name: string,
    vpc: Vpc,
    gatekeeperKeyName: TerraformVariable,
    ami: string,
    associatePublicIpAddress = false
  ) {
    super(scope, name);

    // todo: check this works + how to download a key pair from aws
    // const keyPair = new KeyPair(this, `${name}-key-pair`, {
    //   keyName: `${name}-key-pair`,
    //   publicKey: publicKey.value,
    // });

    this.securityGroup = new SecurityGroup(scope, `${name}-security-group`, {
      vpcId: vpc.vpcIdOutput,
      name,
      lifecycle: {
        createBeforeDestroy: true, // see https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#recreating-a-security-group
      },
    });

    this.ec2 = new Instance(this, `${name}-ec2`, {
      ami,
      instanceType: 't2.micro',
      keyName: gatekeeperKeyName.value,
      associatePublicIpAddress,
      tags: {
        Name: name,
      },
      // choose a random subnet in the given vpc
      subnetId: Fn.element(Token.asList(vpc.publicSubnetsOutput), 0),
      securityGroups: [this.securityGroup.id],
    });

    // allow ssh from anywhere
    // Do not use the `ingress` and `egress` directly on the SecurityGroup for limitations reasons
    // See note on https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#protocol
    new VpcSecurityGroupIngressRule(this, `${name}-allow-inbound-ssh`, {
      cidrIpv4: '0.0.0.0/0',
      fromPort: 22,
      ipProtocol: 'tcp',
      securityGroupId: this.securityGroup.id,
      toPort: 22,
    });

    // allow all egress
    allowAllEgressRule(scope, name, this.securityGroup.id);
  }
}
