import {
  LbListenerRule,
  LbListenerRuleCondition,
} from '@cdktf/provider-aws/lib/lb-listener-rule';
import { LbTargetGroup } from '@cdktf/provider-aws/lib/lb-target-group';
import { LbTargetGroupAttachment } from '@cdktf/provider-aws/lib/lb-target-group-attachment';

import { Construct } from 'constructs';

import { Vpc } from '../.gen/modules/vpc';
import { Ec2 } from './ec2';
import { LoadBalancer } from './load_balancer';
import { AllowedSecurityGroupInfo } from './security_group';

export class BaremetalService extends Construct {
  name: string;
  public instance: Ec2;

  constructor(
    scope: Construct,
    id: string,
    vpc: Vpc,
    config: {
      name: string;
      keyName: string;
      instanceAmi: string;
      instanceType: string;
      allowedSecurityGroups: ({ port: number } & AllowedSecurityGroupInfo)[];
    },
    isActive: boolean,
    loadBalancerConfig: {
      loadBalancer: LoadBalancer;
      port: number;
      host: string;
      healthCheckPath: string;
      priority: number;
      ruleConditions: LbListenerRuleCondition[];
    },
  ) {
    const name = `${id}-${config.name}-ec2`;
    super(scope, name);
    this.name = name;

    this.instance = new Ec2(
      this,
      name,
      vpc,
      config.keyName,
      config.instanceAmi,
      config.instanceType,
      // use a public ip address
      true,
      // make the instance state follow on/off of the infra
      isActive,
    );

    if (config.allowedSecurityGroups.length > 0) {
      for (const group of config.allowedSecurityGroups) {
        this.instance.addSecurityGroupIngress({
          port: group.port,
          name: group.targetName,
          id: group.groupId,
        });
      }
    }

    const targetGroup = new LbTargetGroup(this, `${name}-target-group`, {
      dependsOn: [loadBalancerConfig.loadBalancer.lbl],
      name,
      port: loadBalancerConfig.port,
      protocol: 'HTTP',
      targetType: 'instance',
      vpcId: vpc.vpcIdOutput,
      healthCheck: {
        enabled: true,
        path: loadBalancerConfig.healthCheckPath,
        healthyThreshold: 3,
        unhealthyThreshold: 3,
        timeout: 6, // in seconds the response time after which the target is considered un-healthy
        interval: 60, // in seconds
      },
    });
    // register the ec2 instance as an attachement to the target group
    new LbTargetGroupAttachment(this, `${name}-target-group-attachement`, {
      targetGroupArn: targetGroup.arn,
      targetId: this.instance.ec2.id,
    });
    // Makes the listener forward requests from host to the target group
    new LbListenerRule(this, `${name}-rule`, {
      listenerArn: loadBalancerConfig.loadBalancer.lbl.arn,
      priority: loadBalancerConfig.priority,
      action: [{ type: 'forward', targetGroupArn: targetGroup.arn }],

      condition: [
        { hostHeader: { values: [loadBalancerConfig.host] } },
        // add rule conditions
        ...(loadBalancerConfig.ruleConditions ?? []),
      ],
    });
  }
}
